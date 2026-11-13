terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.29"
    }
  }

  # The bucket name carries the account id, so it is supplied at init time:
  #   terraform -chdir=infra/prod init -backend-config="bucket=qatoto-tfstate-<account-id>"
  # The workflow passes it from the TF_STATE_BUCKET repository variable.
  # `use_lockfile` is S3-native locking (Terraform >= 1.10) — no DynamoDB table.
  backend "s3" {
    key          = "prod/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "qatoto"
      ManagedBy = "terraform"
      Stack     = "prod"
    }
  }
}

# Reads CLOUDFLARE_API_TOKEN from the environment. Scope the token to
# Zone → DNS → Edit on the qatoto.com zone only (a Read-only token is enough for plan).
provider "cloudflare" {}
