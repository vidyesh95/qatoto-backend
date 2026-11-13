# AWS Budgets: the first two budgets in an account are free.
#
# include_credit = false makes the alert fire on GROSS spend. On a newer "free plan"
# account the credits would otherwise absorb every charge and the budget would never
# notice a leak (an idle Elastic IP, an unlimited-credit burst, a forgotten snapshot)
# until the credits were gone. The limit (var.monthly_budget_usd) therefore sits just
# above the stack's expected gross cost, not at zero — see its description.
resource "aws_budgets_budget" "monthly_cost" {
  name         = "qatoto-monthly-cost"
  budget_type  = "COST"
  limit_amount = var.monthly_budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = false
    include_refund = false
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
