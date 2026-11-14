# The DEFAULT VPC and its public subnets: no NAT Gateway (about $32/month and never in
# the free tier). The instance reaches Aiven, Backblaze, GHCR and the third-party APIs
# directly through its public IP.
data "aws_vpc" "default" {
  default = true
}

# Not every instance type is offered in every AZ, so the
# subnet is chosen from the zones that actually offer var.instance_type.
data "aws_ec2_instance_type_offerings" "zones_offering_instance_type" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

data "aws_subnets" "default_public_in_offering_zones" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }

  filter {
    name   = "availability-zone"
    values = data.aws_ec2_instance_type_offerings.zones_offering_instance_type.locations
  }
}

# Cloudflare's published edge ranges (https://www.cloudflare.com/ips/). A range Cloudflare
# adds shows up as new rules in the next plan.
data "cloudflare_ip_ranges" "edge" {}

locals {
  # sort() keeps the choice stable between plans, so the instance is never replaced
  # just because the API listed subnets in a different order.
  api_subnet_id = sort(data.aws_subnets.default_public_in_offering_zones.ids)[0]

  # IPv4 only: the default VPC has no IPv6 CIDR, so the instance has no IPv6 address and
  # the DNS record is an A record. 2 ports × ~15 ranges stays well under the default quota
  # of 60 inbound rules per security group.
  cloudflare_ingress_rules = {
    for port_and_range in setproduct([80, 443], data.cloudflare_ip_ranges.edge.ipv4_cidrs) :
    "${port_and_range[0]}_${port_and_range[1]}" => { port = port_and_range[0], cidr_ipv4 = port_and_range[1] }
  }
}

# ONLY CLOUDFLARE MAY CONNECT (api.qatoto.com is a proxied record, dns.tf). Hitting the
# Elastic IP directly would skip the WAF and rate-limit rules, so it is not reachable.
# 443 is the API; 80 only redirects to HTTPS (Cloudflare forwards plain-HTTP visitors to
# port 80 unless "Always Use HTTPS" is on). No UDP: Cloudflare reaches origins over TCP.
# THERE IS NO PORT 22. Shell access is SSM Session Manager, and deploys are SSM Run
# Command — both ride the agent's outbound HTTPS connection.
resource "aws_security_group" "api" {
  name        = "qatoto-api"
  description = "Qatoto API: HTTP/HTTPS from Cloudflare only, no SSH"
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name = "qatoto-api"
  }
}

resource "aws_vpc_security_group_ingress_rule" "api_from_cloudflare" {
  for_each = local.cloudflare_ingress_rules

  security_group_id = aws_security_group.api.id
  description       = "Cloudflare edge, port ${each.value.port}"
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr_ipv4
}

resource "aws_vpc_security_group_egress_rule" "api_all_ipv4" {
  security_group_id = aws_security_group.api.id
  description       = "all outbound IPv4"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "api_all_ipv6" {
  security_group_id = aws_security_group.api.id
  description       = "all outbound IPv6"
  ip_protocol       = "-1"
  cidr_ipv6         = "::/0"
}
