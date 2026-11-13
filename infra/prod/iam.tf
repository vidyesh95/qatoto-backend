data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  github_oidc_host = "token.actions.githubusercontent.com"
  account_id       = data.aws_caller_identity.current.account_id

  # Every runtime secret lives under this Parameter Store path as a SecureString,
  # one parameter per environment variable (see infra/README.md). Terraform never
  # writes them, so no secret ever lands in the state file.
  ssm_parameter_path = "/qatoto/prod"

  # Created by infra/bootstrap (same name there). The apply role is DENIED creating or
  # granting permissions to any qatoto-* role without exactly this boundary. Built as a
  # string, not a data source: the apply role is also denied every IAM call on it.
  workload_boundary_arn = "arn:${data.aws_partition.current.partition}:iam::${local.account_id}:policy/qatoto-workload-boundary"
}

# Created by infra/bootstrap.
data "aws_iam_openid_connect_provider" "github_actions" {
  url = "https://${local.github_oidc_host}"
}

# ── Instance role ───────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api_instance" {
  name                 = "qatoto-api-instance"
  description          = "Qatoto API EC2 instance: SSM agent plus read access to /qatoto/prod parameters"
  assume_role_policy   = data.aws_iam_policy_document.ec2_assume_role.json
  permissions_boundary = local.workload_boundary_arn
}

# Session Manager shell + Run Command (the deploy channel).
resource "aws_iam_role_policy_attachment" "api_instance_ssm_core" {
  role       = aws_iam_role.api_instance.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# No kms:Decrypt statement: SecureStrings encrypted with the AWS-managed `aws/ssm` key
# are decryptable by any same-account principal calling through SSM — that key's policy
# grants it. A customer-managed key would need an explicit grant here.
data "aws_iam_policy_document" "api_instance_read_runtime_parameters" {
  statement {
    sid = "ReadProdRuntimeParameters"
    actions = [
      "ssm:GetParametersByPath",
      "ssm:GetParameters",
      "ssm:GetParameter",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:ssm:${var.region}:${local.account_id}:parameter${local.ssm_parameter_path}",
      "arn:${data.aws_partition.current.partition}:ssm:${var.region}:${local.account_id}:parameter${local.ssm_parameter_path}/*",
    ]
  }
}

resource "aws_iam_role_policy" "api_instance_read_runtime_parameters" {
  name   = "read-runtime-parameters"
  role   = aws_iam_role.api_instance.id
  policy = data.aws_iam_policy_document.api_instance_read_runtime_parameters.json
}

resource "aws_iam_instance_profile" "api_instance" {
  name = "qatoto-api-instance"
  role = aws_iam_role.api_instance.name
}

# ── Deploy role (assumed by .github/workflows/deploy.yml) ───────────────────────

# THE REPOSITORY IS PUBLIC: `sub` is pinned to the `production` environment, so only a
# job that declares `environment: production` can assume this role. Fork pull requests
# never receive an OIDC token.
data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github_actions.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = ["repo:${var.github_repository}:environment:production"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "qatoto-deploy"
  description          = "GitHub Actions deploy: SSM Run Command on the Qatoto API instance only"
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600
  permissions_boundary = local.workload_boundary_arn
}

data "aws_iam_policy_document" "deploy_run_command" {
  # SendCommand needs BOTH the target instance and the document in its resource list.
  statement {
    sid     = "SendShellCommandToApiInstance"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.api.arn,
      "arn:${data.aws_partition.current.partition}:ssm:${var.region}::document/AWS-RunShellScript",
    ]
  }

  # These three do not support resource-level permissions.
  statement {
    sid = "ReadCommandResults"
    actions = [
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
      "ssm:ListCommands",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy_run_command" {
  name   = "run-command-on-api-instance"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy_run_command.json
}
