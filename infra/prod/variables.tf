variable "region" {
  description = "AWS region. ap-south-1 (Mumbai) is the closest region to the Aiven Bangalore database."
  type        = string
  default     = "ap-south-1"
}

variable "instance_type" {
  description = <<-EOT
    EC2 instance type. Defaults to t4g.small (AWS Graviton2 ARM64, 2 vCPU, 2 GiB RAM),
    a free-plan-eligible type in ap-south-1 (Mumbai), paid from free-plan credits.
    Must be a burstable T type: credit_specification in ec2.tf pins it to `standard`.
  EOT
  type        = string
  default     = "t4g.small"

  validation {
    condition     = can(regex("^(t2|t3|t3a|t4g)\\.(nano|micro|small|medium)$", var.instance_type))
    error_message = "instance_type must be a burstable T-family type such as t4g.small, t4g.micro, t3.micro or t2.micro."
  }
}

variable "arch" {
  description = "CPU architecture of instance_type: arm64 (t4g Graviton) or x86_64 (t2/t3/t3a). Must match the image the deploy workflow builds (repo variable DEPLOY_ARCH)."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["x86_64", "arm64"], var.arch)
    error_message = "arch must be x86_64 or arm64."
  }

  # Without this a mismatch only surfaces at RunInstances (AMI architecture vs type).
  validation {
    condition     = startswith(var.instance_type, "t4g.") == (var.arch == "arm64")
    error_message = "arch must be arm64 for t4g.* instance types and x86_64 for t2/t3/t3a."
  }
}

variable "api_hostname" {
  description = "Public hostname of the API. Must equal NEXT_PUBLIC_API_URL's host on Vercel."
  type        = string
  default     = "api.qatoto.com"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.api_hostname))
    error_message = "api_hostname must be a lowercase DNS name such as api.qatoto.com."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id of the domain that holds api_hostname (Cloudflare dashboard → domain → Overview)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be the 32-character hex zone id."
  }
}

variable "github_repository" {
  description = "owner/name of the repository whose deploy workflow may run commands on the instance."
  type        = string
  default     = "vidyesh95/qatoto-backend"
}

variable "root_volume_size_gb" {
  description = "Root gp3 volume size. The EBS free tier covers 30 GB in total."
  type        = number
  default     = 20

  validation {
    condition     = var.root_volume_size_gb >= 10 && var.root_volume_size_gb <= 30
    error_message = "root_volume_size_gb must be between 10 and 30 to stay inside the EBS free tier."
  }
}

variable "monthly_budget_usd" {
  description = <<-EOT
    Monthly GROSS cost budget (budget.tf excludes credits). This stack costs about
    $14/month gross — t4g.small, one public IPv4, 20 GB gp3 — all paid from free-plan
    credits. An alert therefore means something beyond those three is billing.
  EOT
  type        = string
  default     = "20"
}

variable "budget_alert_email" {
  description = "Address that receives budget alerts. Pass via TF_VAR_budget_alert_email — the repository is public, so never commit it in a .tfvars file."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_alert_email))
    error_message = "budget_alert_email must be an email address."
  }
}
