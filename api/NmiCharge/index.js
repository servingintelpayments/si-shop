const { getSecret, getSecrets } = require("../shared/keyvault");
/**
 * SI Marketplace — Azure Function: NmiCharge
 * Receives a Collect.js payment_token from the frontend,
 * charges the card via NMI server-to-server API,
 * and voids the transaction on Avalara if payment fails.
 *
 * Trigger: HTTP POST /api/NmiCharge
 *
 * Request body:
 * {
 *   "token": "collect_js_payment_token",
 *   "amount": "2344.87",
 *   "avalaraTransactionCode": "abc-123",  // from committed Avalara transaction
 *   "orderRef": "SI-1234567890",
 *   "billing": {
 *     "firstName": "Jane", "lastName": "Cruz",
 *     "email": "jane@acme.com", "company": "Acme Corp",
 *     "address1": "123 Business Ave", "city": "Chicago",
 *     "state": "IL", "zip": "60601", "country": "US", "phone": "3125550199"
 *   }
 * }
 */



const querystring                = require("querystring");


let _nmiConfig = null;

async function getNmiConfig() {
  if (_nmiConfig) return _nmiConfig;
  const credential = new DefaultAzureCredential();
  const client     = new SecretClient(KV_URL, credential);
  const key        = await client.getSecret("NMI-SECURITY-KEY");
  _nmiConfig = { securityKey: key.value };
  return _nmiConfig;
}

module.exports = async function (context, req) {
  context.log("NmiCharge triggered");

  const { token, amount, billing, orderRef, avalaraTransactionCode } = req.body || {};

  if (!token || !amount || !billing) {
    context.res = { status: 400, body: { error: "Missing token, amount, or billing" } };
    return;
  }

  try {
    const cfg = await getNmiConfig();

    // ── NMI sale via payment token ──────────────────────────────────────────
    const nmiParams = {
      security_key:    cfg.securityKey,
      type:            "sale",
      payment_token:   token,
      amount:          parseFloat(amount).toFixed(2),
      currency:        "USD",
      order_id:        orderRef || `SI-${Date.now()}`,
      // Billing
      first_name:      billing.firstName,
      last_name:       billing.lastName,
      email:           billing.email,
      company:         billing.company  || "",
      address1:        billing.address1 || "",
      city:            billing.city     || "",
      state:           billing.state    || "",
      zip:             billing.zip      || "",
      country:         billing.country  || "US",
      phone:           billing.phone    || "",
      // AVS + CVV
      processor_id:    "",
    };

    const nmiRes  = await fetch("https://secure.nmi.com/api/transact.php", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    querystring.stringify(nmiParams),
    });

    const nmiRaw    = await nmiRes.text();
    const nmiResult = Object.fromEntries(new URLSearchParams(nmiRaw));

    // response=1 → approved, response=2 → declined, response=3 → error
    if (nmiResult.response !== "1") {
      context.log.warn("NMI declined:", nmiResult.responsetext);

      // ── Void the Avalara committed transaction on failure ─────────────────
      if (avalaraTransactionCode) {
        await voidAvalaraTransaction(avalaraTransactionCode, context);
      }

      context.res = {
        status: 402,
        body: {
          error:   "Payment declined",
          message: nmiResult.responsetext,
          avsResponse: nmiResult.avsresponse,
          cvvResponse: nmiResult.cvvresponse,
        },
      };
      return;
    }

    context.res = {
      status: 200,
      body: {
        transactionId: nmiResult.transactionid,
        authCode:      nmiResult.authcode,
        avsResponse:   nmiResult.avsresponse,
        cvvResponse:   nmiResult.cvvresponse,
        amount:        parseFloat(amount).toFixed(2),
      },
    };

  } catch (err) {
    context.log.error("NmiCharge error:", err.message);
    context.res = { status: 500, body: { error: "Payment processing error", detail: err.message } };
  }
};

// ── Void Avalara transaction if payment fails ──────────────────────────────────
async function voidAvalaraTransaction(transactionCode, context) {
  try {
    const credential  = new DefaultAzureCredential();
    const client      = new SecretClient(KV_URL, credential);
    const [acct, key, co] = await Promise.all([
      client.getSecret("AVALARA-ACCOUNT-ID"),
      client.getSecret("AVALARA-LICENSE-KEY"),
      client.getSecret("AVALARA-COMPANY-CODE"),
    ]);

    const authToken = Buffer.from(`${acct.value}:${key.value}`).toString("base64");

    await fetch(
      `https://rest.avatax.com/api/v2/companies/${co.value}/transactions/${transactionCode}/void`,
      {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Basic ${authToken}`,
        },
        body: JSON.stringify({ code: "DocDeleted" }),
      }
    );
    context.log("Avalara transaction voided:", transactionCode);
  } catch (e) {
    context.log.error("Failed to void Avalara transaction:", e.message);
  }
}

