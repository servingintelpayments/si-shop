# SI Shop — ServingIntel Procurement Portal

A full-stack procurement portal for ServingIntel customers and employees.
Built on Azure Static Web Apps + Azure Functions + Dynamics 365.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS — Azure Static Web App |
| Backend | Azure Functions (Node 18) |
| Auth | Azure AD B2C (customers) + Azure AD SSO (employees) |
| CRM | Dynamics 365 / Dataverse |
| Payments | NMI Gateway + Collect.js |
| Tax | Avalara AvaTax REST v2 |
| Product Search | Amazon PA-API v5 |
| Secrets | Azure Key Vault (Managed Identity) |
| CI/CD | GitHub Actions |

---

## Project Structure

```
si-shop/
├── frontend/
│   ├── index.html                  # Full SPA — all screens
│   └── staticwebapp.config.json    # SWA routing + headers
│
├── api/
│   ├── host.json                   # Functions host config
│   ├── package.json                # Dependencies
│   ├── local.settings.json         # Local dev env vars (gitignored)
│   ├── shared/
│   │   └── keyvault.js             # Shared Key Vault helper
│   ├── GetProducts/                # Fetch D365 product catalog + prices
│   ├── CalculateTax/               # Avalara real-time tax calculation
│   ├── NmiCharge/                  # NMI card charge + Avalara void on fail
│   ├── CreateD365Quote/            # Create Quote + Sales Order in D365
│   └── AmazonSearch/               # Amazon PA-API product search
│
├── infra/
│   └── setup.sh                    # One-time Azure resource provisioning
│
└── .github/
    └── workflows/
        └── deploy.yml              # CI/CD — auto deploy on push to main
```

---

## Quick Start

### Prerequisites
- Azure CLI installed: `brew install azure-cli`
- Node.js 18+
- Azure subscription with owner access
- GitHub account

### 1. Clone the repo
```bash
git clone https://github.com/YOUR_ORG/si-shop.git
cd si-shop
```

### 2. Provision Azure infrastructure
```bash
# Edit infra/setup.sh — fill in all YOUR_ placeholders
chmod +x infra/setup.sh
./infra/setup.sh
```

### 3. Add GitHub Secret
Go to your repo → Settings → Secrets → Actions → New secret
```
Name:  AZURE_STATIC_WEB_APPS_API_TOKEN
Value: (output from setup.sh)
```

### 4. Push to deploy
```bash
git push origin main
# GitHub Actions auto-deploys frontend + API to Azure
```

---

## Azure Key Vault Secrets

| Secret Name | Description |
|---|---|
| `D365-CLIENT-ID` | Azure AD App Registration client ID |
| `D365-CLIENT-SECRET` | Azure AD App Registration client secret |
| `D365-TENANT-ID` | Azure AD tenant ID |
| `AVALARA-ACCOUNT-ID` | Avalara account ID |
| `AVALARA-LICENSE-KEY` | Avalara license key |
| `AVALARA-COMPANY-CODE` | Avalara company code (e.g. DEFAULT) |
| `NMI-SECURITY-KEY` | NMI private security key |
| `AMAZON-PA-ACCESS-KEY` | Amazon PA-API access key |
| `AMAZON-PA-SECRET-KEY` | Amazon PA-API secret key |
| `AMAZON-PA-PARTNER-TAG` | Amazon Associates partner tag |

---

## Portal Modes

### Customer Portal
- Login: email + password via Azure AD B2C
- Browse SI Shop catalog at retail prices
- Checkout with NMI card payment
- Tax calculated live via Avalara by ZIP code
- D365 Quote auto-created on payment

### Employee Portal
- Login: @servingintel.com via Microsoft SSO
- Three roles: `rep` | `manager` | `admin`
- Place orders on behalf of customers
- Internal price list + discount override
- Source products from Amazon PA-API
- Fulfill orders — manual Amazon / vendor ordering
- Manager: All Orders tab
- Admin: User management + Item Requests

---

## Demo Credentials (Preview Only)

| Role | Email |
|---|---|
| Customer | `customer@acme.com` |
| Rep | `rep@servingintel.com` |
| Manager | `manager@servingintel.com` |
| Admin | `admin@servingintel.com` |

---

## Environment Variables (Function App)

Set via Azure Portal or `az functionapp config appsettings set`:

```
KEY_VAULT_URL              https://si-shop-kv.vault.azure.net
D365_BASE_URL              https://yourorg.crm.dynamics.com/api/data/v9.2
DEFAULT_PRICE_LIST_NAME    Retail Price List
SI_MARKUP_PCT              35
```

---

## Fulfillment Flow

```
Customer pays → D365 Quote (Won) created
             → D365 Sales Order created
             → Power Automate fires purchasing Task
             → Employee sees order in SI Shop employee portal
             → Physical items: employee orders from Amazon/vendor manually
             → Employee pastes order ID back into D365
             → Customer notified when shipped
```

---

## Local Development

```bash
cd api
npm install
cp local.settings.json.example local.settings.json
# Fill in local.settings.json with dev credentials
func start

# In another terminal — serve frontend
cd frontend
npx serve .
```

---

## Deployment

Push to `main` → GitHub Actions runs → deploys to Azure Static Web App automatically.

Pull requests get a staging preview URL automatically.
