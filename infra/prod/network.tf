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

locals {
  # sort() keeps the choice stable between plans, so the instance is never replaced
  # just because the API listed subnets in a different order.
  api_subnet_id = sort(data.aws_subnets.default_public_in_offering_zones.ids)[0]

  public_ingress_rules = {
    http_ipv4  = { protocol = "tcp", port = 80, cidr_ipv4 = "0.0.0.0/0", cidr_ipv6 = null }
    https_ipv4 = { protocol = "tcp", port = 443, cidr_ipv4 = "0.0.0.0/0", cidr_ipv6 = null }
    http3_ipv4 = { protocol = "udp", port = 443, cidr_ipv4 = "0.0.0.0/0", cidr_ipv6 = null }
    http_ipv6  = { protocol = "tcp", port = 80, cidr_ipv4 = null, cidr_ipv6 = "::/0" }
    https_ipv6 = { protocol = "tcp", port = 443, cidr_ipv4 = null, cidr_ipv6 = "::/0" }
    http3_ipv6 = { protocol = "udp", port = 443, cidr_ipv4 = null, cidr_ipv6 = "::/0" }
  }
}

# Port 80 serves the ACME HTTP-01 challenge and the redirect to HTTPS; 443 is the API.
# THERE IS NO PORT 22. Shell access is SSM Session Manager, and deploys are SSM Run
# Command — both ride the agent's outbound HTTPS connection.
resource "aws_security_group" "api" {
  name        = "qatoto-api"
  description = "Qatoto API: public HTTP/HTTPS only, no SSH"
  vpc_id      = data.aws_vpc.default.id

  tags = {
    Name = "qatoto-api"
  }
}

resource "aws_vpc_security_group_ingress_rule" "api_public" {
  for_each = local.public_ingress_rules

  security_group_id = aws_security_group.api.id
  description       = each.key
  ip_protocol       = each.value.protocol
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr_ipv4
  cidr_ipv6         = each.value.cidr_ipv6
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
