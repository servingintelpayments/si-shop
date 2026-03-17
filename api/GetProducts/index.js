const { getSecret, getSecrets } = require("../shared/keyvault");
/**
 * SI Marketplace — Azure Function: GetProducts
 * Fetches the full product catalog + pricing from Dynamics 365.
 *
 * Trigger: HTTP GET /api/GetProducts
 * Query params:
 *   ?priceListName=Retail+Price+List   (optional, defaults to env var)
 *   ?category=Monthly+Services         (optional, filter by D365 product group)
 *
 * Response:
 * {
 *   "priceList": { "id": "...", "name": "Retail Price List" },
 *   "products": [
 *     {
 *       "id":          "d365-product-guid",
 *       "sku":         "SVC:ECOMM-SL",
 *       "name":        "eCommerce SL Setup",
 *       "description": "...",
 *       "category":    "eServices",
 *       "unit":        "EA",
 *       "price":       1250.00,
 *       "currency":    "USD",
 *       "stock":       999
 *     },
 *     ...
 *   ]
 * }
 *
 * D365 tables used:
 *   products              → product catalog (name, SKU, description)
 *   productpriceleveldetails → prices per product per price list
 *   priceleveldetails     → the price list itself
 *   uomschedules / uoms   → units of measure (EA, Month, etc.)
 */





const D365_URL    = process.env.D365_BASE_URL;  // https://yourorg.crm.dynamics.com/api/data/v9.2
const DEFAULT_PL  = process.env.DEFAULT_PRICE_LIST_NAME || "Retail Price List";

// ── Token cache ───────────────────────────────────────────────────────────────
let _token    = null;
let _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;

  const cred   = new DefaultAzureCredential();
  const kv     = new SecretClient(KV_URL, cred);

  const [clientId, clientSecret, tenantId] = await Promise.all([
    kv.getSecret("D365-CLIENT-ID"),
    kv.getSecret("D365-CLIENT-SECRET"),
    kv.getSecret("D365-TENANT-ID"),
  ]);

  const res  = await fetch(
    `https://login.microsoftonline.com/${tenantId.value}/oauth2/v2.0/token`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "client_credentials",
        client_id:     clientId.value,
        client_secret: clientSecret.value,
        scope:         `${D365_URL}/.default`,
      }),
    }
  );

  const data  = await res.json();
  _token      = data.access_token;
  _tokenExp   = Date.now() + (data.expires_in - 60) * 1000;
  return _token;
}

function d365Headers(token) {
  return {
    "Authorization":    `Bearer ${token}`,
    "Accept":           "application/json",
    "OData-MaxVersion": "4.0",
    "OData-Version":    "4.0",
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function (context, req) {
  context.log("GetProducts triggered");

  const priceListName = req.query.priceListName || DEFAULT_PL;
  const categoryFilter = req.query.category || null;

  try {
    const token   = await getToken();
    const headers = d365Headers(token);

    // ── Step 1: Find the Price List ──────────────────────────────────────────
    const plRes  = await fetch(
      `${D365_URL}/pricelevels?$filter=name eq '${encodeURIComponent(priceListName)}'&$select=pricelevelid,name,currencyid`,
      { headers }
    );
    const plData = await plRes.json();

    if (!plData.value?.length) {
      context.res = {
        status: 404,
        body: { error: `Price list "${priceListName}" not found in D365.` },
      };
      return;
    }

    const priceList   = plData.value[0];
    const priceListId = priceList.pricelevelid;

    // ── Step 2: Fetch all products with pricing for this price list ──────────
    // productpriceleveldetails joins products to price lists
    let pplFilter = `_pricelevelid_value eq '${priceListId}' and statecode eq 0`;

    const pplRes  = await fetch(
      `${D365_URL}/productpriceleveldetails` +
      `?$filter=${encodeURIComponent(pplFilter)}` +
      `&$select=productpriceleveldetailid,amount,_productid_value,_uomid_value` +
      `&$expand=productid($select=productnumber,name,description,productstructure,_defaultuomscheduleid_value),uomid($select=name)` +
      `&$top=500`,
      { headers }
    );
    const pplData = await pplRes.json();

    if (!pplData.value?.length) {
      context.res = {
        status: 200,
        body: { priceList: { id: priceListId, name: priceList.name }, products: [] },
      };
      return;
    }

    // ── Step 3: Fetch product group (category) for each product ───────────────
    // D365 uses "product families" (productid with productstructure=1 = family/group)
    // We'll get subjects or product families linked to products
    const productIds = [...new Set(pplData.value.map(p => p._productid_value))];

    // Fetch product family associations in one batch call
    const familyFilter = productIds.map(id => `_parentproductid_value eq '${id}'`).join(" or ");

    // Actually fetch the products directly with their subject/category
    const prodFilter = productIds.map(id => `productid eq '${id}'`).join(" or ");
    const prodRes    = await fetch(
      `${D365_URL}/products?$filter=${encodeURIComponent(prodFilter)}` +
      `&$select=productid,productnumber,name,description,quantityonhand,_subjectid_value` +
      `&$expand=subjectid($select=title)` +
      `&$top=500`,
      { headers }
    );
    const prodData = await prodRes.json();

    // Build product lookup map
    const productMap = {};
    for (const p of (prodData.value || [])) {
      productMap[p.productid] = p;
    }

    // ── Step 4: Shape and merge results ──────────────────────────────────────
    let products = pplData.value.map(ppl => {
      const prod = productMap[ppl._productid_value] || {};
      const cat  = prod.subjectid?.title || "General";

      return {
        id:          ppl._productid_value,
        sku:         prod.productnumber   || "",
        name:        ppl.productid?.name  || prod.name || "",
        description: prod.description     || "",
        category:    cat,
        unit:        ppl.uomid?.name      || "EA",
        price:       ppl.amount           || 0,
        currency:    "USD",
        stock:       prod.quantityonhand != null ? prod.quantityonhand : 999,
      };
    });

    // ── Step 5: Optional category filter ─────────────────────────────────────
    if (categoryFilter) {
      products = products.filter(p =>
        p.category.toLowerCase() === categoryFilter.toLowerCase()
      );
    }

    // Sort: by category then name
    products.sort((a, b) =>
      a.category.localeCompare(b.category) || a.name.localeCompare(b.name)
    );

    // ── Cache headers — CDN can cache for 5 min ───────────────────────────────
    context.res = {
      status: 200,
      headers: {
        "Content-Type":  "application/json",
        "Cache-Control": "public, max-age=300",  // 5 min CDN cache
      },
      body: {
        priceList: {
          id:       priceListId,
          name:     priceList.name,
          currency: "USD",
        },
        products,
        fetchedAt: new Date().toISOString(),
      },
    };

  } catch (err) {
    context.log.error("GetProducts error:", err.message);
    context.res = {
      status: 500,
      body: { error: "Failed to fetch products from D365", detail: err.message },
    };
  }
};

