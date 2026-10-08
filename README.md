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

**Supported versions:** major like 20 or exact like 20.11.1 (installs the newest matching official Node.js release)

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

**Supported versions:** major.minor like 3.11 or exact like 3.11.17 (installs the newest matching standalone build)

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

**Supported versions:** major.minor like 3.2 or exact like 3.2.8 (installs the newest matching build on Ubuntu; Amazon Linux uses its distro package)

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
