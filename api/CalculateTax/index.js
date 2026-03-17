const { getSecret, getSecrets } = require("../shared/keyvault");
/**
 * SI Marketplace — Azure Function: CalculateTax
 * Calls Avalara AvaTax REST v2 to calculate real-time sales tax.
 *
 * Trigger: HTTP POST
 * Endpoint: /api/CalculateTax
 *
 * Request body:
 * {
 *   "commit": false,              // true only on final Place Order
 *   "customerCode": "jane@acme.com",
 *   "purchaseOrderNo": "PO-1234", // optional
 *   "shipTo": {
 *     "line1": "123 Business Ave",
 *     "city": "Chicago",
 *     "region": "IL",
 *     "postalCode": "60601",
 *     "country": "US"
 *   },
 *   "lines": [
 *     { "itemCode": "MSF-SP11-256", "description": "Surface Pro 11", "quantity": 1, "amount": 1299.00 },
 *     { "itemCode": "M365-BP-MO",   "description": "Microsoft 365",   "quantity": 5, "amount": 110.00  }
 *   ]
 * }
 *
 * Response:
 * {
 *   "subtotal": 1409.00,
 *   "tax": 133.86,
 *   "total": 1542.86,
 *   "taxLines": [
 *     { "itemCode": "MSF-SP11-256", "tax": 123.41, "taxRate": 0.0951 },
 *     { "itemCode": "M365-BP-MO",   "tax": 10.45,  "taxRate": 0.0950 }
 *   ],
 *   "transactionCode": "abc-123"  // populated when commit=true
 * }
 */




// ── Key Vault client (uses Managed Identity — no secrets in code) ─────────────
 // e.g. https://si-marketplace-kv.vault.azure.net
let _kvSecrets   = null;

async function getAvalaraConfig() {
  if (_kvSecrets) return _kvSecrets;

  const credential = new DefaultAzureCredential();
  const client     = new SecretClient(KV_URL, credential);

  const [accountId, licenseKey, companyCode] = await Promise.all([
    client.getSecret("AVALARA-ACCOUNT-ID"),
    client.getSecret("AVALARA-LICENSE-KEY"),
    client.getSecret("AVALARA-COMPANY-CODE"),
  ]);

  _kvSecrets = {
    accountId:   accountId.value,
    licenseKey:  licenseKey.value,
    companyCode: companyCode.value,
    baseUrl:     "https://rest.avatax.com/api/v2", // production
    // sandbox:  "https://sandbox-rest.avatax.com/api/v2"
  };

  return _kvSecrets;
}

// ── Tax code mapping ──────────────────────────────────────────────────────────
// Avalara system tax codes: https://taxcode.avatax.avalara.com
const TAX_CODE_MAP = {
  Hardware:    "P0000000",  // Tangible personal property (computers, monitors, etc.)
  Software:    "SW054003",  // SaaS / cloud-hosted software (subscription)
  Peripherals: "P0000000",  // Physical peripherals (keyboards, headsets, etc.)
  Networking:  "P0000000",  // Physical networking hardware
  default:     "P0000000",
};

function getTaxCode(category) {
  return TAX_CODE_MAP[category] || TAX_CODE_MAP.default;
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function (context, req) {
  context.log("CalculateTax triggered");

  // ── Validate request ────────────────────────────────────────────────────────
  const body = req.body;

  if (!body?.shipTo?.postalCode || !body?.lines?.length) {
    context.res = {
      status: 400,
      body: { error: "Missing required fields: shipTo.postalCode and lines[]" },
    };
    return;
  }

  try {
    const cfg = await getAvalaraConfig();

    // ── Build Avalara transaction ────────────────────────────────────────────
    const isCommit  = body.commit === true;
    const docType   = isCommit ? "SalesInvoice" : "SalesOrder";
    // SalesOrder   = preview / quote  (NOT recorded in Avalara)
    // SalesInvoice = committed        (recorded, used for filing)

    const avalaraPayload = {
      type:            docType,
      companyCode:     cfg.companyCode,
      date:            new Date().toISOString().split("T")[0],
      customerCode:    body.customerCode || "guest",
      purchaseOrderNo: body.purchaseOrderNo || "",
      commit:          isCommit,

      addresses: {
        shipFrom: {
          // Your warehouse / origin address
          line1:      "1 SI Marketplace Way",
          city:       "Austin",
          region:     "TX",
          postalCode: "78701",
          country:    "US",
        },
        shipTo: {
          line1:      body.shipTo.line1      || "",
          city:       body.shipTo.city       || "",
          region:     body.shipTo.region     || "",
          postalCode: body.shipTo.postalCode,
          country:    body.shipTo.country    || "US",
        },
      },

      lines: body.lines.map((line, i) => ({
        number:      String(i + 1),
        itemCode:    line.itemCode,
        description: line.description || "",
        quantity:    line.quantity,
        amount:      line.amount,                        // line total (qty × unit price)
        taxCode:     getTaxCode(line.category),
      })),

      // Optional: tag transactions in Avalara dashboard
      referenceCode: `SI-${Date.now()}`,
      description:   "SI Marketplace Order",
    };

    // ── Call Avalara ─────────────────────────────────────────────────────────
    const authToken = Buffer.from(`${cfg.accountId}:${cfg.licenseKey}`).toString("base64");

    const avalaraRes = await fetch(`${cfg.baseUrl}/transactions/create`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Basic ${authToken}`,
        "X-Avalara-Client": "SI-Marketplace;1.0.0;AzureFunction",
      },
      body: JSON.stringify(avalaraPayload),
    });

    if (!avalaraRes.ok) {
      const errBody = await avalaraRes.text();
      context.log.error("Avalara error:", errBody);
      context.res = {
        status: avalaraRes.status,
        body: { error: "Avalara tax calculation failed", detail: errBody },
      };
      return;
    }

    const avalaraData = await avalaraRes.json();

    // ── Shape response for frontend ──────────────────────────────────────────
    const taxLines = (avalaraData.lines || []).map(line => ({
      itemCode: line.itemCode,
      tax:      Math.round(line.tax * 100) / 100,
      taxRate:  line.details?.[0]?.rate || 0,
    }));

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: {
        subtotal:        Math.round(avalaraData.totalAmount * 100) / 100,
        tax:             Math.round(avalaraData.totalTax    * 100) / 100,
        total:           Math.round((avalaraData.totalAmount + avalaraData.totalTax) * 100) / 100,
        taxLines,
        transactionCode: isCommit ? avalaraData.code : null,
        docType,
      },
    };

  } catch (err) {
    context.log.error("CalculateTax error:", err.message);
    context.res = {
      status: 500,
      body: { error: "Internal error calculating tax", detail: err.message },
    };
  }
};

