terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
    postgresql = {
      source  = "oktug/kubernetes-postgresql"
      version = "~> 1.0"
    }
    redis = {
      source  = "bitnami/helm-charts"
      version = "~> 18.0"
    }
    natstrader = {
      source  = "nats/nats"
      version = "~> 1.0"
    }
    clickhouse = {
      source  = "ClickHouse/clickhouse-kubernetes"
      version = "~> 0.3"
    }
  }

  backend "local" {
    path = "terraform/state"
  }
}

provider "aws" {
  region = "us-east-1"
}

provider "kubernetes" {
  host                   = data.aws_eks_cluster.cluster.endpoint
  token                  = data.aws_eks_cluster_auth.cluster_auth
 _insecure_skip_tls_verify = true
}

data "aws_eks_cluster" "cluster" {
  name = "urlshortener-eks"
}

data "aws_eks_cluster_auth" "cluster_auth" {
  name = "urlshortener-eks"
  cluster_name = "urlshortener-eks"
}

module "namespace" {
  source = "./k8s"
}

module "postgres" {
  source = "./postgres"
}

module "redis" {
  source = "./redis"
}

module "nats" {
  source = "./nats"
}

module "clickhouse" {
  source = "./clickhouse"
}

module "app" {
  source = "./app"
}