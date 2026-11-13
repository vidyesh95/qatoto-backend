output "instance_id" {
  description = "GitHub repo variable EC2_INSTANCE_ID; also the target for `aws ssm start-session`."
  value       = aws_instance.api.id
}

output "public_ip" {
  description = "Elastic IP. Add <ip>/32 to the Aiven service's IP allowlist."
  value       = aws_eip.api.public_ip
}

output "deploy_role_arn" {
  description = "GitHub repo variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.deploy.arn
}

output "api_url" {
  description = "Must equal NEXT_PUBLIC_API_URL on Vercel."
  value       = "https://${var.api_hostname}"
}
