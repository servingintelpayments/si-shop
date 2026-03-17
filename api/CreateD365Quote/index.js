const { getSecret, getSecrets } = require("../shared/keyvault");
/**
 * SI Marketplace — Azure Function: CreateD365Quote
 * Creates a Quote in Dynamics 365 after successful payment.
 * Includes tax amount from Avalara, NMI transaction ID, line items.
 *
 * Trigger: HTTP POST /api/CreateD365Quote
 */





const D365_BASE_URL = process.env.D365_BASE_URL; // e.g. https://yourorg.crm.dynamics.com/api/data/v9.2

let _d365Token     = null;
let _d365TokenExp  = 0;

async function getD365Token() {
  if (_d365Token && Date.now() < _d365TokenExp) return _d365Token;

  const credential = new DefaultAzureCredential();
  const client     = new SecretClient(KV_URL, credential);

  const [clientId, clientSecret, tenantId] = await Promise.all([
    client.getSecret("D365-CLIENT-ID"),
    client.getSecret("D365-CLIENT-SECRET"),
    client.getSecret("D365-TENANT-ID"),
  ]);

  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenantId.value}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "client_credentials",
        client_id:     clientId.value,
        client_secret: clientSecret.value,
        scope:         `${D365_BASE_URL}/.default`,
      }),
    }
  );

  const tokenData = await tokenRes.json();
  _d365Token    = tokenData.access_token;
  _d365TokenExp = Date.now() + (tokenData.expires_in - 60) * 1000;
  return _d365Token;
}

module.exports = async function (context, req) {
  context.log("CreateD365Quote triggered");

  const {
    customerEmail, customerName, companyName,
    transactionId, authCode,
    subtotal, tax, total,
    avalaraTransactionCode,
    purchaseOrderNo,
    shipTo,
    lineItems,
  } = req.body || {};

  if (!customerEmail || !lineItems?.length) {
    context.res = { status: 400, body: { error: "Missing required fields" } };
    return;
  }

  try {
    const token = await getD365Token();

    const headers = {
      "Authorization":    `Bearer ${token}`,
      "Content-Type":     "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version":    "4.0",
      "Prefer":           "return=representation",
    };

    // ── 1. Look up existing Account by email domain ────────────────────────
    const domain     = customerEmail.split("@")[1];
    const accountRes = await fetch(
      `${D365_BASE_URL}/accounts?$filter=emailaddress1 eq '${customerEmail}' or websiteurl eq '${domain}'&$select=accountid,name&$top=1`,
      { headers }
    );
    const accountData = await accountRes.json();
    const accountId   = accountData.value?.[0]?.accountid || null;

    // ── 2. Look up or create Contact ───────────────────────────────────────
    const contactRes = await fetch(
      `${D365_BASE_URL}/contacts?$filter=emailaddress1 eq '${customerEmail}'&$select=contactid&$top=1`,
      { headers }
    );
    const contactData = await contactRes.json();
    let contactId     = contactData.value?.[0]?.contactid;

    if (!contactId) {
      const [firstName, ...rest] = (customerName || "").split(" ");
      const newContact = await fetch(`${D365_BASE_URL}/contacts`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          firstname:      firstName || customerName,
          lastname:       rest.join(" ") || "",
          emailaddress1:  customerEmail,
          parentcustomerid_account: accountId
            ? { "@odata.type": "Microsoft.Dynamics.CRM.account", accountid: accountId }
            : undefined,
        }),
      });
      const newContactData = await newContact.json();
      contactId = newContactData.contactid;
    }

    // ── 3. Create Quote ────────────────────────────────────────────────────
    const quotePayload = {
      name:               `SI Marketplace — ${customerName} — ${new Date().toLocaleDateString()}`,
      description:        `NMI TxnID: ${transactionId} | Auth: ${authCode} | Avalara: ${avalaraTransactionCode || "N/A"}`,
      purchaseorderno:    purchaseOrderNo || "",
      freighttermscode:   1,     // FOB
      shippingmethodcode: 1,     // Airborne

      // Money fields (D365 uses base currency)
      totallineitemamount: subtotal,
      totaltax:            tax,
      totalamount:         total,

      // Ship to
      shipto_name:            customerName,
      shipto_line1:           shipTo?.line1      || "",
      shipto_city:            shipTo?.city        || "",
      shipto_stateorprovince: shipTo?.region      || "",
      shipto_postalcode:      shipTo?.postalCode  || "",
      shipto_country:         shipTo?.country     || "US",

      // Link to contact and account
      "customerid_contact@odata.bind":  contactId  ? `/contacts(${contactId})`  : undefined,
      "customerid_account@odata.bind":  accountId  ? `/accounts(${accountId})`  : undefined,

      // Status: Won (quote has been paid)
      statecode:  1,
      statuscode: 4,
    };

    const quoteRes  = await fetch(`${D365_BASE_URL}/quotes`, {
      method: "POST", headers, body: JSON.stringify(quotePayload),
    });
    const quote     = await quoteRes.json();
    const quoteId   = quote.quoteid;
    const quoteNum  = quote.quotenumber;

    // ── 4. Add Quote Detail lines ──────────────────────────────────────────
    await Promise.all(lineItems.map((item, i) =>
      fetch(`${D365_BASE_URL}/quotedetails`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          "quoteid@odata.bind": `/quotes(${quoteId})`,
          productdescription:   item.name,
          quantity:             item.qty,
          priceperunit:         item.unitPrice,
          extendedamount:       item.qty * item.unitPrice,
          tax:                  item.tax || 0,
          lineitemnumber:       i + 1,
        }),
      })
    ));

    context.res = {
      status: 200,
      body: { quoteId, quoteNumber: quoteNum, status: "Won" },
    };

  } catch (err) {
    context.log.error("CreateD365Quote error:", err.message);
    context.res = { status: 500, body: { error: "Failed to create D365 quote", detail: err.message } };
  }
};

