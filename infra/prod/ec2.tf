# Amazon Linux 2023: the SSM agent and AWS CLI v2 ship in the image.
data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${var.arch}"
}

locals {
  docker_compose_version = "v5.7.1"
  docker_compose_arch    = var.arch == "arm64" ? "aarch64" : "x86_64"
}

resource "aws_instance" "api" {
  ami                    = data.aws_ssm_parameter.al2023_ami.insecure_value
  instance_type          = var.instance_type
  subnet_id              = local.api_subnet_id
  vpc_security_group_ids = [aws_security_group.api.id]
  iam_instance_profile   = aws_iam_instance_profile.api_instance.name

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    docker_compose_version = local.docker_compose_version
    docker_compose_arch    = local.docker_compose_arch
  })

  # IMDSv2 only. Hop limit 1 keeps the instance credentials out of reach of containers.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # t3/t4g default to `unlimited`, which BILLS for CPU surplus once credits run out — the
  # classic free-tier surprise. `standard` throttles to baseline instead of charging.
  credit_specification {
    cpu_credits = "standard"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    encrypted             = true
    delete_on_termination = true
  }

  tags = {
    Name = "qatoto-api"
  }

  lifecycle {
    # A newer AL2023 AMI or an edited bootstrap script must not silently replace the
    # running box. To roll either forward on purpose:
    #   terraform apply -replace=aws_instance.api
    ignore_changes = [ami, user_data]
  }
}

# A stable address for the Cloudflare A record across instance replacements.
# Public IPv4 costs $0.005/hour; the old (12-month) free tier covers 750 hours/month
# of it, the newer free plan pays it from credits.
resource "aws_eip" "api" {
  domain = "vpc"

  tags = {
    Name = "qatoto-api"
  }
}

resource "aws_eip_association" "api" {
  instance_id   = aws_instance.api.id
  allocation_id = aws_eip.api.id
}
