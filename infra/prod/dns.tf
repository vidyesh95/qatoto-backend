# DNS-ONLY (grey cloud) ON PURPOSE. src/app.ts sets `trust proxy` to 1 — exactly one
# proxy (Caddy on the instance) — so req.ip is the left-of-Caddy address. Orange-clouding
# this record puts Cloudflare in front as a second hop, and every rate-limit key becomes
# a Cloudflare edge IP. Changing that needs an app change first (trust proxy + the
# CF-Connecting-IP header), not a toggle here.
#
# If an `api` record already exists in the zone (left over from Dokploy), either delete it
# in the dashboard or import it before the first apply:
#   terraform -chdir=infra/prod import cloudflare_dns_record.api '<zone_id>/<record_id>'
resource "cloudflare_dns_record" "api" {
  zone_id = var.cloudflare_zone_id
  name    = var.api_hostname
  type    = "A"
  content = aws_eip.api.public_ip
  ttl     = 300
  proxied = false
  comment = "Qatoto API on EC2, managed by Terraform (infra/prod). Keep DNS-only."
}
