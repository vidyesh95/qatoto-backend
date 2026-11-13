# One-time bootstrap. Applied BY HAND, with LOCAL state, before infra/prod exists:
#
#   terraform -chdir=infra/bootstrap init
#   terraform -chdir=infra/bootstrap apply
#
# It creates what infra/prod and the GitHub workflows cannot create for themselves:
# the S3 bucket that holds infra/prod's state, the GitHub OIDC identity provider, the
# permissions boundary every infra/prod role must carry, and the two roles
# .github/workflows/terraform.yml assumes. Its own state file
# (infra/bootstrap/terraform.tfstate) is gitignored — keep a copy somewhere safe, or
# re-import its resources if it is ever lost. Nothing in it is secret.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.73"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "qatoto"
      ManagedBy = "terraform"
      Stack     = "bootstrap"
    }
  }
}

variable "region" {
  description = "AWS region for the state bucket. Keep it equal to infra/prod's region."
  type        = string
  default     = "ap-south-1"
}

variable "github_repository" {
  description = "owner/name of the repository whose workflows may assume the Terraform roles."
  type        = string
  default     = "vidyesh95/qatoto-backend"
}

data "aws_caller_identity" "current" {}

locals {
  account_id           = data.aws_caller_identity.current.account_id
  github_oidc_host     = "token.actions.githubusercontent.com"
  state_bucket_name    = "qatoto-tfstate-${local.account_id}"
  prod_state_key_glob  = "prod/*"
  prod_state_lock_key  = "prod/terraform.tfstate.tflock" # infra/prod backend key + ".tflock"
  managed_name_pattern = "qatoto-*"

  # infra/prod/iam.tf builds the same ARN from the same name. Change both together.
  workload_boundary_name = "qatoto-workload-boundary"
}

# ── Terraform state bucket ──────────────────────────────────────────────────────

resource "aws_s3_bucket" "terraform_state" {
  bucket = local.state_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Versioning is the undo button for a corrupted state file; 90 days of old versions is
# plenty and keeps the bucket comfortably inside the S3 free tier.
resource "aws_s3_bucket_lifecycle_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# ── GitHub Actions OIDC ─────────────────────────────────────────────────────────

resource "aws_iam_openid_connect_provider" "github_actions" {
  url            = "https://${local.github_oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

# THE REPOSITORY IS PUBLIC. Every trust policy below pins `sub` to one exact claim —
# never `repo:<owner>/<repo>:*`, which would let any branch or workflow in the repo
# assume the role. Fork pull requests never receive an OIDC token at all.
data "aws_iam_policy_document" "terraform_plan_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = ["repo:${var.github_repository}:pull_request"]
    }
  }
}

data "aws_iam_policy_document" "terraform_apply_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Only a job running in the `infra` GitHub environment, which has a required reviewer.
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = ["repo:${var.github_repository}:environment:infra"]
    }
  }
}

# Apply: full read/write of infra/prod state.
data "aws_iam_policy_document" "terraform_state_read_write" {
  statement {
    sid       = "ListStateBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.terraform_state.arn]
  }

  statement {
    sid       = "ReadWriteProdState"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/${local.prod_state_key_glob}"]
  }
}

# Plan: read the state, and write ONLY the lock object `use_lockfile` creates and removes.
# A pull request controls the plan job, so it must not be able to overwrite or delete
# production state.
data "aws_iam_policy_document" "terraform_state_read_and_lock" {
  statement {
    sid       = "ListStateBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.terraform_state.arn]
  }

  statement {
    sid       = "ReadProdState"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/${local.prod_state_key_glob}"]
  }

  statement {
    sid       = "WriteProdStateLock"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.terraform_state.arn}/${local.prod_state_lock_key}"]
  }
}

# ── Plan role (pull requests) ───────────────────────────────────────────────────

resource "aws_iam_role" "terraform_plan" {
  name                 = "qatoto-tf-plan"
  description          = "terraform plan for infra/prod from same-repo pull requests"
  assume_role_policy   = data.aws_iam_policy_document.terraform_plan_trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "terraform_plan_read_only" {
  role       = aws_iam_role.terraform_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy" "terraform_plan_state" {
  name   = "terraform-state"
  role   = aws_iam_role.terraform_plan.id
  policy = data.aws_iam_policy_document.terraform_state_read_and_lock.json
}

# ReadOnlyAccess includes ssm:GetParameter*, and the AWS-managed `aws/ssm` key decrypts
# for any same-account caller. Without this Deny, any same-repo pull request (no reviewer)
# could print every /qatoto/prod SecureString from its plan job. infra/prod reads only the
# PUBLIC AMI parameter (arn:aws:ssm:<region>::parameter/aws/service/…, no account id),
# which this does not match.
data "aws_iam_policy_document" "terraform_plan_deny_parameter_values" {
  statement {
    sid    = "DenyReadingAccountParameterValues"
    effect = "Deny"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
      "ssm:GetParameterHistory",
    ]
    resources = ["arn:aws:ssm:*:${local.account_id}:parameter/*"]
  }
}

resource "aws_iam_role_policy" "terraform_plan_deny_parameter_values" {
  name   = "deny-parameter-values"
  role   = aws_iam_role.terraform_plan.id
  policy = data.aws_iam_policy_document.terraform_plan_deny_parameter_values.json
}

# ── Permissions boundary for every role infra/prod creates ──────────────────────

# The ceiling for the instance role and the deploy role: SSM only (agent channel,
# Run Command, parameter reads and their aws/ssm decryption). A role carrying this
# boundary can never exceed it, whatever policy is attached to it.
data "aws_iam_policy_document" "workload_boundary" {
  statement {
    sid       = "SsmAgentRunCommandAndParameters"
    actions   = ["ssm:*", "ssmmessages:*", "ec2messages:*"]
    resources = ["*"]
  }

  statement {
    sid       = "DecryptSecureStringsThroughSsm"
    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "workload_boundary" {
  name        = local.workload_boundary_name
  description = "Permissions boundary required on every qatoto-* role the Terraform apply role creates"
  policy      = data.aws_iam_policy_document.workload_boundary.json
}

# ── Apply role (workflow_dispatch in the `infra` environment) ───────────────────

resource "aws_iam_role" "terraform_apply" {
  name                 = "qatoto-tf-apply"
  description          = "terraform apply for infra/prod from the approved infra environment"
  assume_role_policy   = data.aws_iam_policy_document.terraform_apply_trust.json
  max_session_duration = 3600
}

# PowerUserAccess covers EC2, SSM, Budgets and S3 but deliberately excludes IAM. The
# inline policy below re-grants IAM only for `qatoto-*` names. That alone would still
# let this role create `qatoto-anything` with AdministratorAccess, trust itself, and
# assume it (PowerUserAccess includes sts:*). So every role it creates or edits must
# carry the workload boundary, which it can neither remove nor rewrite.
resource "aws_iam_role_policy_attachment" "terraform_apply_power_user" {
  role       = aws_iam_role.terraform_apply.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

data "aws_iam_policy_document" "terraform_apply_scoped_iam" {
  statement {
    sid     = "ManageQatotoRolesAndProfiles"
    actions = ["iam:*"]
    resources = [
      "arn:aws:iam::${local.account_id}:role/${local.managed_name_pattern}",
      "arn:aws:iam::${local.account_id}:instance-profile/${local.managed_name_pattern}",
      "arn:aws:iam::${local.account_id}:policy/${local.managed_name_pattern}",
    ]
  }

  # The apply role must never edit its own trust or permissions, nor the plan role's,
  # nor the boundary that caps every role it manages.
  statement {
    sid     = "DenyEditingBootstrapRolesAndBoundary"
    effect  = "Deny"
    actions = ["iam:*"]
    resources = [
      aws_iam_role.terraform_plan.arn,
      aws_iam_role.terraform_apply.arn,
      aws_iam_policy.workload_boundary.arn,
    ]
  }

  # A role may only be created, or given permissions, while it carries the boundary.
  statement {
    sid    = "DenyQatotoRolesWithoutWorkloadBoundary"
    effect = "Deny"
    actions = [
      "iam:CreateRole",
      "iam:PutRolePermissionsBoundary",
      "iam:AttachRolePolicy",
      "iam:PutRolePolicy",
    ]
    resources = ["arn:aws:iam::${local.account_id}:role/${local.managed_name_pattern}"]

    condition {
      test     = "StringNotEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.workload_boundary.arn]
    }
  }

  statement {
    sid       = "DenyRemovingWorkloadBoundary"
    effect    = "Deny"
    actions   = ["iam:DeleteRolePermissionsBoundary"]
    resources = ["arn:aws:iam::${local.account_id}:role/${local.managed_name_pattern}"]
  }

  statement {
    sid = "ReadOidcProvider"
    actions = [
      "iam:GetOpenIDConnectProvider",
      "iam:ListOpenIDConnectProviders",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "terraform_apply_scoped_iam" {
  name   = "scoped-iam"
  role   = aws_iam_role.terraform_apply.id
  policy = data.aws_iam_policy_document.terraform_apply_scoped_iam.json
}

resource "aws_iam_role_policy" "terraform_apply_state" {
  name   = "terraform-state"
  role   = aws_iam_role.terraform_apply.id
  policy = data.aws_iam_policy_document.terraform_state_read_write.json
}

# ── Outputs → GitHub repository variables ───────────────────────────────────────

output "terraform_state_bucket_name" {
  description = "GitHub repo variable TF_STATE_BUCKET, and -backend-config=bucket=… for local runs."
  value       = aws_s3_bucket.terraform_state.bucket
}

output "terraform_plan_role_arn" {
  description = "GitHub repo variable AWS_TF_PLAN_ROLE_ARN."
  value       = aws_iam_role.terraform_plan.arn
}

output "terraform_apply_role_arn" {
  description = "GitHub repo variable AWS_TF_APPLY_ROLE_ARN."
  value       = aws_iam_role.terraform_apply.arn
}

output "github_oidc_provider_arn" {
  description = "Read by infra/prod through a data source; listed here for reference."
  value       = aws_iam_openid_connect_provider.github_actions.arn
}
