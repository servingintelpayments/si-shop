const { getSecret, getSecrets } = require("../shared/keyvault");
/**
 * SI Marketplace — Azure Function: AmazonSearch
 * Searches Amazon Product Advertising API v5 (PA-API).
 * Returns products with ASIN, title, price, image, URL.
 *
 * Trigger: HTTP GET /api/AmazonSearch?q=epson+receipt+printer&category=Electronics
 *
 * Response:
 * {
 *   "query": "epson receipt printer",
 *   "results": [
 *     {
 *       "asin":       "B08N5WRWNW",
 *       "title":      "Epson TM-T88VII Thermal Receipt Printer",
 *       "brand":      "Epson",
 *       "price":      210.99,
 *       "listPrice":  249.99,
 *       "image":      "https://m.media-amazon.com/images/...",
 *       "url":        "https://www.amazon.com/dp/B08N5WRWNW",
 *       "rating":     4.6,
 *       "reviewCount": 312,
 *       "prime":      true,
 *       "suggestedSIPrice": 284.84   // Amazon price + CFG.DEFAULT_MARKUP_PCT %
 *     }
 *   ]
 * }
 *
 * PA-API requires:
 *   - Amazon Associates account (free): https://affiliate-program.amazon.com
 *   - Access Key + Secret Key + Partner Tag (associate tag)
 *   - Store in Azure Key Vault
 */



const crypto                     = require("crypto");


const DEFAULT_MARKUP = parseFloat(process.env.SI_MARKUP_PCT || "35") / 100;
const AWS_HOST       = "webservices.amazon.com";
const AWS_REGION     = "us-east-1";

let _amzConfig = null;

async function getAmazonConfig() {
  if (_amzConfig) return _amzConfig;
  const cred   = new DefaultAzureCredential();
  const client = new SecretClient(KV_URL, cred);
  const [ak, sk, tag] = await Promise.all([
    client.getSecret("AMAZON-PA-ACCESS-KEY"),
    client.getSecret("AMAZON-PA-SECRET-KEY"),
    client.getSecret("AMAZON-PA-PARTNER-TAG"),
  ]);
  _amzConfig = { accessKey: ak.value, secretKey: sk.value, partnerTag: tag.value };
  return _amzConfig;
}

// ── AWS Signature v4 ──────────────────────────────────────────────────────────
function sign(key, msg) {
  return crypto.createHmac("sha256", key).update(msg).digest();
}
function getSignatureKey(key, dateStamp, region, service) {
  return sign(sign(sign(sign("AWS4" + key, dateStamp), region), service), "aws4_request");
}

async function paApiRequest(cfg, payload) {
  const now         = new Date();
  const amzDate     = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp   = amzDate.slice(0, 8);
  const path        = "/paapi5/searchitems";
  const service     = "ProductAdvertisingAPI";
  const contentType = "application/json; charset=UTF-8";
  const bodyStr     = JSON.stringify(payload);
  const bodyHash    = crypto.createHash("sha256").update(bodyStr).digest("hex");

  const headers = {
    "content-encoding":                "amz-1.0",
    "content-type":                    contentType,
    "host":                            AWS_HOST,
    "x-amz-date":                      amzDate,
    "x-amz-target":                    "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems",
  };

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort()
    .map(k => `${k}:${headers[k]}\n`).join("");

  const canonicalRequest = [
    "POST", path, "",
    canonicalHeaders, signedHeaders, bodyHash,
  ].join("\n");

  const credScope  = `${dateStamp}/${AWS_REGION}/${service}/aws4_request`;
  const strToSign  = ["AWS4-HMAC-SHA256", amzDate, credScope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");

  const sigKey  = getSignatureKey(cfg.secretKey, dateStamp, AWS_REGION, service);
  const sig     = crypto.createHmac("sha256", sigKey).update(strToSign).digest("hex");

  const auth = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;

  const res = await fetch(`https://${AWS_HOST}${path}`, {
    method:  "POST",
    headers: { ...headers, "Authorization": auth },
    body:    bodyStr,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PA-API error ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function (context, req) {
  context.log("AmazonSearch triggered");

  const query    = req.query.q || "";
  const category = req.query.category || "All";   // PA-API SearchIndex

  if (!query || query.length < 2) {
    context.res = { status: 400, body: { error: "Query must be at least 2 characters" } };
    return;
  }

  // Map SI categories to Amazon SearchIndex values
  const searchIndexMap = {
    "POS Hardware":          "Electronics",
    "Kitchen Display":       "Electronics",
    "Kiosk":                 "Electronics",
    "Integrations":          "Electronics",
    "eServices":             "Software",
    "Monthly Services":      "Software",
    "Professional Services": "All",
    "All":                   "All",
  };
  const searchIndex = searchIndexMap[category] || "All";

  try {
    const cfg = await getAmazonConfig();

    const payload = {
      PartnerTag:    cfg.partnerTag,
      PartnerType:   "Associates",
      Marketplace:   "www.amazon.com",
      Keywords:      query,
      SearchIndex:   searchIndex,
      ItemCount:     10,
      Resources: [
        "Images.Primary.Large",
        "ItemInfo.Title",
        "ItemInfo.ByLineInfo",
        "Offers.Listings.Price",
        "Offers.Listings.DeliveryInfo.IsPrimeEligible",
        "ItemInfo.ProductInfo",
        "CustomerReviews.Count",
        "CustomerReviews.StarRating",
      ],
    };

    // DEMO MODE — return mock results when credentials not configured
    // Remove this block once PA-API credentials are in Key Vault
    if (!cfg.accessKey || cfg.accessKey === "YOUR_KEY") {
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
        body: getMockResults(query),
      };
      return;
    }

    const data    = await paApiRequest(cfg, payload);
    const items   = data.SearchResult?.Items || [];

    const results = items.map(item => {
      const price    = item.Offers?.Listings?.[0]?.Price?.Amount || 0;
      const siPrice  = Math.round(price * (1 + DEFAULT_MARKUP) * 100) / 100;
      return {
        asin:             item.ASIN,
        title:            item.ItemInfo?.Title?.DisplayValue || "Unknown",
        brand:            item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue || "",
        price,
        listPrice:        item.Offers?.Listings?.[0]?.Price?.SavingBasis?.Amount || price,
        image:            item.Images?.Primary?.Large?.URL || "",
        url:              `https://www.amazon.com/dp/${item.ASIN}?tag=${cfg.partnerTag}`,
        rating:           item.CustomerReviews?.StarRating?.Value || null,
        reviewCount:      item.CustomerReviews?.Count || 0,
        prime:            item.Offers?.Listings?.[0]?.DeliveryInfo?.IsPrimeEligible || false,
        suggestedSIPrice: siPrice,
      };
    });

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
      body: { query, searchIndex, results },
    };

  } catch (err) {
    context.log.error("AmazonSearch error:", err.message);
    context.res = {
      status: 500,
      body: { error: "Amazon search failed", detail: err.message },
    };
  }
};

// ── Mock results for demo / before PA-API credentials are configured ──────────
function getMockResults(query) {
  return {
    query,
    results: [
      {
        asin: "C31CJ57212", title: `Epson TM-T88VII Thermal Receipt Printer — USB/Ethernet (matching: "${query}")`,
        brand: "Epson", price: 210.99, listPrice: 249.99,
        image: "", url: "https://www.amazon.com/dp/C31CJ57212",
        rating: 4.7, reviewCount: 428, prime: true, suggestedSIPrice: 284.84,
      },
      {
        asin: "B001MS6TZC", title: `APG VPK-15B-1-BX Cash Drawer — USB & Ethernet (matching: "${query}")`,
        brand: "APG", price: 94.95, listPrice: 119.00,
        image: "", url: "https://www.amazon.com/dp/B001MS6TZC",
        rating: 4.5, reviewCount: 312, prime: true, suggestedSIPrice: 128.18,
      },
      {
        asin: "B07MDKP974", title: `Honeywell 1900GSR-2 Barcode Scanner 1D/2D USB (matching: "${query}")`,
        brand: "Honeywell", price: 139.99, listPrice: 169.99,
        image: "", url: "https://www.amazon.com/dp/B07MDKP974",
        rating: 4.6, reviewCount: 891, prime: true, suggestedSIPrice: 188.99,
      },
      {
        asin: "B09RFTMNB2", title: `GL.iNet GL-AXT1800 4G LTE Router with SIM Card Slot (matching: "${query}")`,
        brand: "GL.iNet", price: 184.99, listPrice: 209.00,
        image: "", url: "https://www.amazon.com/dp/B09RFTMNB2",
        rating: 4.4, reviewCount: 567, prime: false, suggestedSIPrice: 249.74,
      },
    ],
  };
}

