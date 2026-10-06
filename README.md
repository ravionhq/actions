# Flightcontrol External Actions

This directory contains example action files for common development tools that can be used with Flightcontrol's runner system.

## Available Actions

### 1. Node.js (`node`)
Installs Node.js with npm support.

**Usage:**
```json
{
  "instructions": [
    {
      "type": "uses",
      "uses": "node",
      "with": {
        "node-version": "18"
      }
    },
    {
      "type": "command",
      "command": "node --version && npm install"
    }
  ]
}
```

**Supported versions:** 16, 18, 20, 21, 22 (uses package manager)

### 2. Python (`python`)
Installs Python with pip support.

**Usage:**
```json
{
  "instructions": [
    {
      "type": "uses",
      "uses": "python",
      "with": {
        "python-version": "3.10"
      }
    },
    {
      "type": "command",
      "command": "python3 --version && pip install -r requirements.txt"
    }
  ]
}
```

**Supported versions:** 3.8, 3.9, 3.10, 3.11, 3.12 (uses package manager)

### 3. Terraform (`terraform`)
Installs Terraform via binary download.

**Usage:**
```json
{
  "instructions": [
    {
      "type": "uses",
      "uses": "terraform",
      "with": {
        "terraform-version": "1.5.0"
      }
    },
    {
      "type": "command",
      "command": "terraform --version"
    }
  ]
}
```

### 4. OpenTofu (`tofu`)
Installs OpenTofu via binary download.

**Usage:**
```json
{
  "instructions": [
    {
      "type": "uses",
      "uses": "tofu",
      "with": {
        "tofu-version": "1.6.0"
      }
    },
    {
      "type": "command",
      "command": "tofu --version"
    }
  ]
}
```

### 5. Google Cloud SDK (`gcp`)
Installs Google Cloud SDK with gcloud, gsutil, and bq.

**Usage:**
```json
{
  "instructions": [
    {
      "type": "uses",
      "uses": "gcp",
      "with": {
        "gcloud-version": "latest"
      }
    },
    {
      "type": "command",
      "command": "gcloud --version && gsutil --version"
    }
  ]
}
```

### 6. Ruby (`ruby`)
Installs Ruby with gem support.

**Usage:**
```json
{
  "instructions": [
    {
      "type": "uses",
      "uses": "ruby",
      "with": {
        "ruby-version": "3.1"
      }
    },
    {
      "type": "command",
      "command": "ruby --version && gem install bundler"
    }
  ]
}
```

**Supported versions:** 3.0, 3.1, 3.2, 3.3 (uses package manager)

### 7. Go (`go`)
Installs Go via binary download.

**Usage:**
```json
{
  "instructions": [
    {
      "type": "uses",
      "uses": "go",
      "with": {
        "go-version": "1.20"
      }
    },
    {
      "type": "command",
      "command": "go version"
    }
  ]
}
```

### 8. Railpack (`railpack`)
Installs Railpack via binary download.

**Usage:**
```json
{
  "instructions": [
    {
      "type": "uses",
      "uses": "railpack",
      "with": {
        "railpack-version": "0.29.0"
      }
    },
    {
      "type": "command",
      "command": "railpack --version"
    }
  ]
}
```

### 9. AWS CLI (`aws-cli`)
Installs version 2 of the AWS CLI with AWS's installer.

**Usage:**
```json
{
  "instructions": [
    {
      "type": "uses",
      "uses": "aws-cli"
    },
    {
      "type": "command",
      "command": "aws --version"
    }
  ]
}
```

## Sandbox Images

`images/` holds the guest images a sandbox step can boot with `infrastructure.image`:

| Image | Contents |
|---|---|
| `ubuntu-24.04` | Ubuntu 24.04 LTS with Docker and the AWS CLI |
| `debian-13` | Debian 13 with Docker and the AWS CLI |

Each `image.yaml` lists the image's packages and the actions it is built with. See [AGENTS.md](AGENTS.md#images) for the format.

## Using Multiple Actions

You can combine multiple actions in a single workflow:

```json
{
  "instructions": [
    {
      "type": "uses",
      "uses": "node",
      "with": {
        "node-version": "18"
      }
    },
    {
      "type": "uses",
      "uses": "python",
      "with": {
        "python-version": "3.11"
      }
    },
    {
      "type": "command",
      "command": "node --version && python3 --version"
    }
  ]
}
```

## File Structure

Each action is defined in a separate directory with an `action.yaml` file:

```
examples/actions/
├── node/action.yaml
├── python/action.yaml
├── terraform/action.yaml
├── tofu/action.yaml
├── gcp/action.yaml
├── ruby/action.yaml
├── go/action.yaml
├── railpack/action.yaml
└── README.md
```

## Deployment

To use these actions in production, copy the action files to the `flightcontrolhq/actions` repository under their respective directories.

## Architecture Support

Binary downloads automatically handle both AMD64 and ARM64 architectures based on the runner's system architecture.
