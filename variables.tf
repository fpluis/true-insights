variable "monday_endpoint_secret" {
  description = "The monday.com endpoint secret to handle calls from the app."
  type        = string
  sensitive   = true
}

variable "monday_secret_key" {
  description = "The monday.com secret key to get an access token."
  type        = string
  sensitive   = true
}

variable "monday_client_id" {
  description = "The monday.com app client id."
  type        = string
  sensitive   = true
}

variable "monday_redirect_uri" {
  description = "The monday.com redirect uri used to authorize the Populate feature."
  type        = string
  sensitive   = true
}

variable "twitter_api_key" {
  description = "The Twitter API key used for backend calls."
  type        = string
  sensitive   = true
}

variable "twitter_secret_key" {
  description = "The Twitter API secret used for backend calls."
  type        = string
  sensitive   = true
}

variable "twitter_callback_url" {
  description = "The Twitter redirect url used to get the permanent access token."
  type        = string
  sensitive   = true
}

variable "api_domain" {
  description = "The domain name for the app's backend."
  type        = string
  sensitive   = true
}

variable "certificate_arn" {
  description = "The AWS certificate arn for the api_domain."
  type        = string
  sensitive   = true
}

variable "zone_id" {
  description = "The id of the Route 53 hosted zone."
  type = string
}

variable "region" {
  description = "The AWS region."
  type        = string
}

variable "tags" {
  description = "The AWS tags common to all resources."
  type        = map(string)
  default     = {}
}
