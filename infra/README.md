# Qatoto backend infrastructure

One EC2 instance in **ap-south-1 (Mumbai)** running Docker Compose. Mumbai is the closest
AWS region to the **Aiven Postgres in Bangalore**.

```
Browser ─► qatoto.com (Vercel) ── rewrite /api/auth/* ──┐
Browser ─► api.qatoto.com (direct API_BASE_URL calls) ──┤
                                                        ▼
       Cloudflare A record, DNS-only (grey cloud) → Elastic IP
                                                        ▼
  EC2 (Amazon Linux 2023, default VPC, ports 80/443 only — no SSH)
    caddy :443 (Let's Encrypt) → api :8000      worker (pg-boss)
    migrate (one-shot per deploy: drizzle-kit migrate + jobs-install)
                                                        ▼
  Aiven Postgres (Bangalore)       Backblaze B2 us-east-1 (presigned URLs)
```

| Path                                      | What it is                                                           | Applied by                 |
| ----------------------------------------- | -------------------------------------------------------------------- | -------------------------- |
| `infra/bootstrap/`                        | State bucket, GitHub OIDC provider, plan/apply roles                 | You, once, local state     |
| `infra/prod/`                             | Instance, EIP, security group, IAM, Cloudflare record, budget alarm  | `terraform.yml` (or you)   |
| `deploy/`                                 | Compose file, Caddyfile, `remote-deploy.sh` — shipped on each deploy | `deploy.yml` via SSM       |
| `infra/scripts/put-runtime-parameters.sh` | Loads a production `.env` into SSM Parameter Store                   | You, when a secret changes |

Runtime secrets live in **SSM Parameter Store** (`/qatoto/prod/<VARIABLE>`, SecureString,
standard tier, free). Terraform never writes them, so no secret is ever in Terraform state.

## Before the first deploy: recover the production secrets

The production environment variables lived on the Dokploy server, and that server is gone.

> ⚠️ **`COMMERCE_PII_ENCRYPTION_SECRET` must be the ORIGINAL value.**
> The encrypted data stores a key version, not the key. If the production database already
> holds encrypted addresses, phone numbers or tax identifiers, a new secret makes every one
> of them permanently unreadable.
>
> The same applies to `INTEGRATION_TOKEN_SECRET`: with a new value, stored provider tokens
> stop decrypting and users must reconnect.
>
> A new `BETTER_AUTH_SECRET` is survivable: it only signs everyone out.

Find these in a password manager or backup before the first boot.

## First-time setup

### 1. Instance type: t4g.small (Graviton2 ARM64)

The infrastructure defaults to **`t4g.small` (`arm64`)** in **ap-south-1 (Mumbai)**:

- **Free plan eligible:** `t4g.small` is a free-plan instance type. On this account (the
  credit-based free plan) it is paid from credits, not free: the stack costs about **$14/month
  gross** (instance + public IPv4 + 20 GB gp3). The free plan ends after 6 months or when the
  credits run out, whichever comes first, and real billing starts then.
- **2 vCPUs & 2 GiB RAM:** Double the memory of `t2.micro` or `t3.micro` (1 GiB), giving the API, background worker and Caddy ample physical RAM without swap contention.
- **Native CI builds:** GitHub Actions provides free `ubuntu-24.04-arm` runners for public repositories, building native `linux/arm64` images without emulation overhead.

If you ever need an x86 instance type instead (e.g. `t2.micro` on older accounts), set `instance_type = "t2.micro"` and `arch = "x86_64"`.

### 2. Bootstrap (local state, once)

```sh
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap apply
terraform -chdir=infra/bootstrap output
```

Keep `infra/bootstrap/terraform.tfstate` somewhere safe. It is gitignored and holds no secrets.

Bootstrap also creates the `qatoto-workload-boundary` permissions boundary. The apply role is
denied creating any `qatoto-*` role, or attaching policies to one, unless the role carries this
boundary, so the role cannot create itself an administrator. `infra/prod/iam.tf` sets the
boundary on both of its roles. If you change bootstrap, apply it before `infra/prod`.

### 3. GitHub settings

Do this in **Settings → Secrets and variables → Actions**, and **Settings → Environments**.

**Environments:**

- `production`: restrict **Deployment branches** to `main`. This is required: the deploy role
  trusts any job that declares `environment: production`. Without the restriction, any branch
  pushed to this repository with such a workflow gets root on the instance through SSM.
- `infra`: add yourself as a **required reviewer**, and restrict deployment branches to `main`.

**Repository variables:**

| Variable                | Value                                            |
| ----------------------- | ------------------------------------------------ |
| `AWS_REGION`            | `ap-south-1`                                     |
| `TF_STATE_BUCKET`       | bootstrap output `terraform_state_bucket_name`   |
| `AWS_TF_PLAN_ROLE_ARN`  | bootstrap output `terraform_plan_role_arn`       |
| `AWS_TF_APPLY_ROLE_ARN` | bootstrap output `terraform_apply_role_arn`      |
| `EC2_INSTANCE_TYPE`     | `t4g.small` (default in Terraform)               |
| `DEPLOY_ARCH`           | `arm64` (default in Terraform & CI)              |
| `API_HOSTNAME`          | `api.qatoto.com`                                 |
| `CLOUDFLARE_ZONE_ID`    | Cloudflare → qatoto.com → Overview → Zone ID     |
| `AWS_DEPLOY_ROLE_ARN`   | set after step 4 (prod output `deploy_role_arn`) |
| `EC2_INSTANCE_ID`       | set after step 4 (prod output `instance_id`)     |

**Secrets:**

| Secret                      | Scope               | Value                                             |
| --------------------------- | ------------------- | ------------------------------------------------- |
| `BUDGET_ALERT_EMAIL`        | repository          | your alert address                                |
| `CLOUDFLARE_API_TOKEN_READ` | repository          | token with Zone → DNS → **Read**, qatoto.com only |
| `CLOUDFLARE_API_TOKEN`      | environment `infra` | token with Zone → DNS → **Edit**, qatoto.com only |

**Cleanup:** delete the old `DOKPLOY_URL`, `DOKPLOY_API_KEY` and `DOKPLOY_COMPOSE_ID` secrets.

### 4. Apply `infra/prod`

The first apply is easiest from your laptop. After that, use Actions → Terraform → Run workflow.

```sh
cp infra/prod/terraform.tfvars.example infra/prod/terraform.tfvars   # then edit it
export TF_VAR_budget_alert_email='you@example.com'
export CLOUDFLARE_API_TOKEN='…edit token…'
terraform -chdir=infra/prod init -backend-config="bucket=qatoto-tfstate-<account-id>"
terraform -chdir=infra/prod apply
```

If Cloudflare already has an `api` record from the Dokploy days, the apply fails with
"record already exists". Fix it one of two ways:

- Delete the record in the Cloudflare dashboard, or
- Import it: `terraform -chdir=infra/prod import cloudflare_dns_record.api '<zone_id>/<record_id>'`

Then fill in `AWS_DEPLOY_ROLE_ARN` and `EC2_INSTANCE_ID` from `terraform output`.

**Confirm the budget alert:** AWS Budgets sends a subscription email. Click the link in it.

### 5. Production secrets → Parameter Store

Write a production dotenv file **outside the repository**, using `.env.example` as the list
of variables.

**Required:**

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `FRONTEND_URL=https://qatoto.com`
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
- `BREVO_API_KEY` (production sends OTP email)
- `DOCS_ENABLED=false`
- `COMMERCE_PII_ENCRYPTION_SECRET`

**Optional** (as before): Cloudinary, `BLACKBLAZE_*`, Gemini, Comtrade, Razorpay test keys,
the GitHub App, and `INTEGRATION_TOKEN_SECRET`.

Leave these out: `DATABASE_POOL_MAX`, `WORKER_DATABASE_POOL_MAX`, `NODE_ENV`, `PORT`, `TZ` and
`DATABASE_CA_CERT_PATH`. The compose file sets them.

Then load the file, together with the Aiven CA certificate:

```sh
infra/scripts/put-runtime-parameters.sh ~/secure/qatoto-production.env ~/secure/aiven-ca.pem
shred -u ~/secure/qatoto-production.env   # or keep it in a password manager, not on disk
```

### 6. Lock down Aiven

In the Aiven console, open the service and go to **Allowed IP addresses**. Replace
`0.0.0.0/0` with:

- `<public_ip>/32`, the Elastic IP from step 4
- your laptop's IP

The free plan has **16 usable connections**, and production uses up to 12 of them. Develop
against a local Postgres or a separate Aiven project, never against this one.

### 7. First deploy

Push to `main`, or use Actions → Deploy → Run workflow. The build pushes
`ghcr.io/vidyesh95/qatoto-backend`.

**After the first build:** open GitHub → your profile → Packages → `qatoto-backend` →
Package settings and confirm the visibility is **Public**. The instance pulls without
credentials, so a private package makes every deploy fail at `docker compose pull`. The
repository is already public, so the image reveals nothing new.

### 8. Point traffic at it

- **Vercel:** `NEXT_PUBLIC_API_URL` must be `https://api.qatoto.com`. The value is inlined at
  build time, so redeploy the frontend if you change it.
- **If the hostname changed:** update the Google and GitHub OAuth redirect URIs, the
  Razorpay webhook URL and the GitHub App callback URL.
- **After about a week of stable running:** terminate the old instance and release any
  Elastic IP it held. An unattached EIP is billed.

## Day-to-day

**Deploying:**

- **Deploy:** merge to `main`.
- **Roll back:** Actions → Deploy → Run workflow, with `image_sha` set to an earlier full
  commit SHA. That commit's compose file and deploy script are used too.

**Operations:**

- **Shell:** `aws ssm start-session --target <instance_id>`. This needs the Session Manager
  plugin installed locally. Then run `sudo -i` and `cd /opt/qatoto`.
- **Logs:** `docker compose logs -f api worker`. Logs rotate at 10 MB × 3 per container.
- **Memory:** `free -m` and `docker stats --no-stream`. The `t4g.small` box is 2 GiB RAM plus 2 GiB swap.

**Changing things:**

- **Change a secret:** re-run `put-runtime-parameters.sh`, or run `aws ssm put-parameter
  --overwrite …`, then redeploy. The `.env` file is re-rendered on every deploy.
- **Infrastructure change:** open a PR touching `infra/` to get a plan, merge it, then Actions →
  Terraform → Run workflow and approve.
- **New AMI or changed `user-data.sh.tftpl`:** run `terraform apply -replace=aws_instance.api`.
  The Elastic IP and DNS stay put. The `caddy_data` volume is lost with the instance, so
  Caddy re-issues the certificate. **The API is down until you finish these two steps:**
    1. Set the `EC2_INSTANCE_ID` repository variable to the new `instance_id` output. Until then,
       deploys target the terminated instance.
    2. Run Actions → Deploy → Run workflow. The new instance runs nothing until it is deployed.

## Free-tier guard rails already in the code

- **No NAT Gateway, no load balancer, no RDS:** none of them is free.
- **`cpu_credits = "standard"`:** burstable instances throttle instead of billing for CPU
  surplus.
- **gp3 root volume of 20 GB:** the EBS free tier covers 30 GB.
- **$20 monthly budget:** it alerts on gross spend (`include_credit = false`), so free-plan
  credits cannot hide a leak. Expected gross spend is about $14/month, so an alert means
  something else is billing.
- **Old images pruned after 7 days:** keeps the disk from filling.
