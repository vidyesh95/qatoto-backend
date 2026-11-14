# PROXIED (orange cloud): Cloudflare's WAF and rate-limit rules see every request, and
# the security group (network.tf) admits only Cloudflare's ranges.
#
# Client IP: src/app.ts keeps `trust proxy = 1`. Caddy believes CF-Connecting-IP only
# from Cloudflare peers and rewrites X-Forwarded-For to that single address (Caddyfile),
# so req.ip is the visitor, not a Cloudflare edge IP.
#
# Requires, in the Cloudflare dashboard (the Terraform token is DNS-only):
#   - SSL/TLS mode "Full (strict)". "Flexible" makes Caddy redirect HTTP→HTTPS forever.
#   - The Origin CA certificate in Parameter Store (CLOUDFLARE_ORIGIN_CERT/_KEY).
#   - No Bot Fight Mode: it cannot exempt /webhooks/* or the Vercel /api/auth rewrite.
#
# If an `api` record already exists in the zone (left over from Dokploy), either delete it
# in the dashboard or import it before the first apply:
#   terraform -chdir=infra/prod import cloudflare_dns_record.api '<zone_id>/<record_id>'
resource "cloudflare_dns_record" "api" {
  zone_id = var.cloudflare_zone_id
  name    = var.api_hostname
  type    = "A"
  content = aws_eip.api.public_ip
  ttl     = 1 # "automatic"; Cloudflare requires it for proxied records
  proxied = true
  comment = "Qatoto API on EC2, managed by Terraform (infra/prod). Proxied; origin admits Cloudflare only."
}
