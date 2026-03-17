# GitHub Secrets Setup Guide
# ════════════════════════════════════════════════════════════
# Go to: github.com/YOUR_ORG/si-shop → Settings → Secrets
#        → Actions → New repository secret
#
# Add EVERY secret below before running the workflow.
# ════════════════════════════════════════════════════════════

# ── REQUIRED FOR DEPLOYMENT ──────────────────────────────────

AZURE_STATIC_WEB_APPS_API_TOKEN
  What:  Deployment token from Azure Static Web App
  Where: Azure Portal → Static Web Apps → si-shop → Manage token
  Note:  Created AFTER you create the Static Web App in Azure

AZURE_CREDENTIALS
  What:  Service principal JSON for Azure CLI in GitHub Actions
  Where: Run this command and paste the full JSON output:
         az ad sp create-for-rbac \
           --name "si-shop-github" \
           --role contributor \
           --scopes /subscriptions/YOUR_SUBSCRIPTION_ID \
           --sdk-auth
  Looks like:
  {
    "clientId": "...",
    "clientSecret": "...",
    "subscriptionId": "...",
    "tenantId": "..."
  }

AZURE_SUBSCRIPTION_ID
  What:  Your Azure subscription ID
  Where: Azure Portal → Subscriptions  OR  run: az account show --query id

# ── DYNAMICS 365 ─────────────────────────────────────────────

D365_CLIENT_ID
  What:  App Registration Client ID
  Where: Azure Portal → App Registrations → your app → Overview → Application (client) ID

D365_CLIENT_SECRET
  What:  App Registration Client Secret
  Where: Azure Portal → App Registrations → your app → Certificates & Secrets → New secret

D365_TENANT_ID
  What:  Your Azure AD Tenant ID
  Where: Azure Portal → Azure Active Directory → Overview → Tenant ID

D365_BASE_URL
  What:  Your D365 org URL
  Format: https://YOUR_ORG.crm.dynamics.com/api/data/v9.2
  Where: D365 → Settings → Customizations → Developer Resources

# ── AVALARA ──────────────────────────────────────────────────

AVALARA_ACCOUNT_ID
  What:  Your Avalara account number
  Where: Avalara dashboard → Settings → License and API Keys

AVALARA_LICENSE_KEY
  What:  Your Avalara license key
  Where: Avalara dashboard → Settings → License and API Keys → Generate

AVALARA_COMPANY_CODE
  What:  Your company code in Avalara
  Where: Avalara dashboard → Settings → Company Settings → Company Code
  Note:  Usually DEFAULT or your company abbreviation

# ── NMI GATEWAY ──────────────────────────────────────────────

NMI_SECURITY_KEY
  What:  Your NMI private security key (server-side only)
  Where: NMI merchant portal → Settings → Security Keys
  ⚠️  Never put this in frontend code — server/Key Vault only

# ── AMAZON PA-API ─────────────────────────────────────────────

AMAZON_PA_ACCESS_KEY
  What:  Amazon PA-API access key
  Where: affiliate-program.amazon.com → Tools → Product Advertising API → Credentials

AMAZON_PA_SECRET_KEY
  What:  Amazon PA-API secret key
  Where: Same location as above

AMAZON_PA_PARTNER_TAG
  What:  Your Amazon Associates tag
  Where: affiliate-program.amazon.com → Account Settings → Associate tag
  Format: yourstore-20

# ════════════════════════════════════════════════════════════
# TOTAL: 13 secrets to add
# ════════════════════════════════════════════════════════════

# DEPLOYMENT ORDER:
# 1. Add all 13 secrets above to GitHub
# 2. Create Azure Static Web App manually in Azure Portal (first time)
#    → Get the AZURE_STATIC_WEB_APPS_API_TOKEN and add it to GitHub
# 3. Push to main → GitHub Actions auto-deploys frontend + API
# 4. Run workflow_dispatch to provision Azure infrastructure
#    (Key Vault, Function App, Managed Identity, all secrets)
