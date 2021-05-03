terraform {
  required_version = "~> 0.14"
  required_providers {
    aws     = "~> 3.27"
    archive = "~> 2.0"
  }
  backend "s3" {
    key     = "terraform.tfstate"
    region  = "eu-west-1"
    encrypt = true
  }
}

provider "aws" {
  region = var.region
}

resource "aws_iam_role" "lambda" {
  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": {
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }
}
EOF
  tags               = var.tags
}

resource "aws_iam_policy" "lambda" {
  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": {
    "Effect": "Allow",
    "Action": [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "dynamodb:*",
      "events:*",
      "lambda:*"
    ],
    "Resource": "*"
  }
}
EOF
}

resource "aws_iam_role_policy_attachment" "lambda" {
  role       = aws_iam_role.lambda.name
  policy_arn = aws_iam_policy.lambda.arn
}

data "archive_file" "nlp" {
  type        = "zip"
  output_path = "${path.module}/.terraform/artifacts/nlp.zip"
  source_dir  = "${path.module}/dist/nlp"
}

resource "aws_lambda_function" "nlp" {
  filename         = data.archive_file.nlp.output_path
  function_name    = "${var.tags.project}-nlp"
  handler          = "index.handler"
  role             = aws_iam_role.lambda.arn
  memory_size      = 4096
  timeout          = 60
  runtime          = "nodejs12.x"
  source_code_hash = data.archive_file.nlp.output_base64sha256
  tags             = var.tags
  depends_on       = [aws_iam_role_policy_attachment.lambda]
}

resource "aws_apigatewayv2_api" "monday" {
  name          = "monday"
  protocol_type = "HTTP"
  cors_configuration {
    allow_headers  = ["authorization", "content-type"]
    allow_methods  = ["*"]
    allow_origins  = ["*"]
    max_age        = 7200
  }
  tags = var.tags
  body = templatefile("./api.yml", {
    api_domain                    = var.api_domain
    authorize_lambda_function_arn = aws_lambda_function.authorize.arn
    nlp_lambda_function_arn       = aws_lambda_function.nlp.arn
  })
}

resource "aws_lambda_permission" "nlp" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.nlp.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.monday.execution_arn}/*"
}

resource "aws_cloudwatch_log_group" "api_logs" {
  name              = "${var.tags.project}-monday"
  retention_in_days = 365
  tags              = var.tags
}

resource "aws_apigatewayv2_stage" "monday" {
  api_id      = aws_apigatewayv2_api.monday.id
  name        = "monday"
  auto_deploy = true
  tags        = var.tags
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_logs.arn
    format          = "$context.identity.sourceIp - - [$context.requestTime] \"$context.httpMethod $context.path $context.protocol\" $context.status $context.responseLength $context.requestId"
  }
}

resource "aws_apigatewayv2_domain_name" "this" {
  domain_name = var.api_domain
  domain_name_configuration {
    certificate_arn = var.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
  tags = var.tags
}

resource "aws_apigatewayv2_api_mapping" "monday" {
  api_id          = aws_apigatewayv2_api.monday.id
  domain_name     = aws_apigatewayv2_domain_name.this.id
  stage           = aws_apigatewayv2_stage.monday.id
  api_mapping_key = "monday"
}

resource "aws_route53_record" "api" {
  name    = aws_apigatewayv2_domain_name.this.domain_name
  type    = "A"
  zone_id = var.zone_id
  alias {
    name                   = aws_apigatewayv2_domain_name.this.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.this.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

data "archive_file" "authorize" {
  type        = "zip"
  output_path = "${path.module}/.terraform/artifacts/authorize.zip"
  source_dir  = "${path.module}/dist/authorize"
}

resource "aws_lambda_function" "authorize" {
  filename      = data.archive_file.authorize.output_path
  function_name = "${var.tags.project}-authorize"
  handler       = "index.handler"
  role          = aws_iam_role.lambda.arn
  memory_size   = 128
  timeout       = 90
  runtime       = "nodejs12.x"
  environment {
    variables = {
      "AWS_NODEJS_CONNECTION_REUSE_ENABLED" = 1
      "MONDAY_ENDPOINT_SECRET"              = var.monday_endpoint_secret
      "MONDAY_SECRET_KEY"                   = var.monday_secret_key
      "MONDAY_CLIENT_ID"                    = var.monday_client_id
      "MONDAY_REDIRECT_URI"                 = var.monday_redirect_uri
      "TWITTER_CALLBACK_URL"                = var.twitter_callback_url
      "TWITTER_API_KEY"                     = var.twitter_api_key
      "TWITTER_SECRET_KEY"                  = var.twitter_secret_key
      "CRAWL_LAMBDA_ARN"                    = aws_lambda_function.crawl.arn
      "PROJECT_NAME"                        = var.tags.project
      "CALLBACK_POPULATE"                   = "https://${var.api_domain}/monday/oauth/callback-populate"
    }
  }
  source_code_hash = data.archive_file.authorize.output_base64sha256
  tags             = var.tags
  depends_on       = [aws_iam_role_policy_attachment.lambda]
}

resource "aws_lambda_permission" "authorize" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.authorize.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.monday.execution_arn}/*"
}

resource "aws_dynamodb_table" "clients" {
  name         = "clients"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  attribute {
    name = "userId"
    type = "S"
  }
  tags = var.tags
}

resource "aws_dynamodb_table" "integrations" {
  name         = "integrations"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "url"
  attribute {
    name = "url"
    type = "S"
  }
  tags = var.tags
}

resource "aws_dynamodb_table" "twitterAuth" {
  name         = "twitterAuth"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "token"
  attribute {
    name = "token"
    type = "S"
  }
  tags = var.tags
}

data "archive_file" "crawl" {
  type        = "zip"
  output_path = "${path.module}/.terraform/artifacts/crawl.zip"
  source_dir  = "${path.module}/dist/crawl"
}

resource "aws_lambda_function" "crawl" {
  filename      = data.archive_file.crawl.output_path
  function_name = "${var.tags.project}-crawl"
  handler       = "index.handler"
  role          = aws_iam_role.lambda.arn
  memory_size   = 128
  timeout       = 900
  runtime       = "nodejs12.x"
  environment {
    variables = {
      "AWS_NODEJS_CONNECTION_REUSE_ENABLED" = 1
      "TWITTER_API_KEY"                     = var.twitter_api_key
      "TWITTER_SECRET_KEY"                  = var.twitter_secret_key
      "MONDAY_ENDPOINT_SECRET"              = var.monday_endpoint_secret
    }
  }
  source_code_hash = data.archive_file.crawl.output_base64sha256
  tags             = var.tags
  depends_on       = [aws_iam_role_policy_attachment.lambda]
}
