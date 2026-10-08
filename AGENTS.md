# Flightcontrol Actions - Developer Guide

This guide helps developers and AI agents create new actions for the Flightcontrol actions repository. Actions are reusable workflow components that install tools and dependencies.

## Overview

Actions provide a GitHub Actions-like way to install tools with specific versions. Users reference actions with `uses: "action-name"` and provide parameters via `with`. The system:

1. Fetches the action file from GitHub (tries `.yaml`, `.yml`, then `.json`)
2. Processes dependency templates, substituting `${{ inputs.param-name }}` with provided values
3. Installs resolved dependencies using the runner's dependency manager
4. Executes any additional instructions

## Action File Structure

Actions are defined in YAML or JSON format with this structure:

```yaml
name: Action Name
description: Brief description of what this action does

inputs:
  param-name:
    description: Description of this parameter
    required: false  # or true
    default: "default-value"

dependencyTemplates:
  - name: dependency-name
    # ... dependency configuration (see below)

instructions: []  # Optional additional commands to run
```

### Required Fields

- `name`: Human-readable name of the action
- `description`: Brief description of what the action does
- `inputs`: Map of input parameters with their definitions
- `dependencyTemplates`: Array of dependency configurations with template placeholders
- `instructions`: Array of additional commands to execute (usually empty for setup actions)

## Input Parameters

Each input parameter can have:

```yaml
inputs:
  version:
    description: Tool version to install
    required: false    # Whether this parameter is mandatory
    default: "1.0.0"   # Default value if not provided
```

Users provide values via the `with` field:

```json
{
  "type": "uses",
  "uses": "action-name",
  "with": {
    "version": "2.0.0"
  }
}
```

## Template Substitution

Use `${{ inputs.param-name }}` syntax to reference input parameters in dependency configurations. The system substitutes these placeholders with actual values at runtime.

**Example:**
```yaml
inputs:
  node-version:
    default: "20"

dependencyTemplates:
  - name: node
    package: nodejs${{ inputs.node-version }}  # Becomes: nodejs20
    version: ${{ inputs.node-version }}        # Becomes: 20
```

Template substitution works in all dependency fields: `package`, `version`, `url`, `installScript.args`, etc.

## Dependency Installation Methods

The runner supports multiple installation methods. Choose the appropriate method based on the tool:

### 1. Package Manager (APT/YUM/APK)

Best for tools available in system package repositories.

```yaml
dependencyTemplates:
  - name: tool-name
    package: package-name${{ inputs.version }}
    version: ${{ inputs.version }}
    checkBinary: binary-name
    alternativePackages:
      - alt-package-1
      - alt-package-2
```

**Fields:**
- `name`: Unique identifier for the dependency
- `package`: Package name (with optional version suffix)
- `version`: Version to install (for verification)
- `checkBinary`: Binary to check if tool is already installed
- `alternativePackages`: Additional packages to install (e.g., dev tools, plugins)

**Example - Node.js:**
```yaml
dependencyTemplates:
  - name: node
    package: nodejs${{ inputs.node-version }}
    version: ${{ inputs.node-version }}
    checkBinary: node
    alternativePackages:
      - nodejs${{ inputs.node-version }}-npm
```

**Example - Python:**
```yaml
dependencyTemplates:
  - name: python
    package: python${{ inputs.python-version }}
    version: ${{ inputs.python-version }}
    checkBinary: python${{ inputs.python-version }}
    alternativePackages:
      - python${{ inputs.python-version }}-dev
      - python${{ inputs.python-version }}-venv
      - python3-pip
```

### 2. Binary Download

Best for tools distributed as precompiled binaries (Go, Terraform, etc.).

```yaml
dependencyTemplates:
  - name: tool-name
    package: tool-name
    installMethod: binary-download
    checkBinary: binary-name
    binaryDownload:
      url: https://example.com/tool-${{ inputs.version }}-linux-$ARCH.tar.gz
      archiveFormat: tar.gz  # or zip
      installPath: /usr/local/bin
      architectureSpecific:
        amd64: amd64
        arm64: arm64
    postInstall:
      - export PATH=$PATH:/some/path
```

**Fields:**
- `installMethod`: Must be `binary-download`
- `binaryDownload.url`: Download URL with `$ARCH` placeholder for architecture
- `binaryDownload.archiveFormat`: Archive type (`tar.gz`, `zip`, `tar`, or `none` for raw binary)
- `binaryDownload.installPath`: Where to extract/install the binary
- `binaryDownload.architectureSpecific`: Maps system architecture to URL architecture string
- `postInstall`: Commands to run after installation (e.g., PATH updates)

**Architecture Mapping:**
The `$ARCH` placeholder in URLs is replaced based on `architectureSpecific`:
- System `amd64` → URL contains `amd64` (if mapped to `amd64`)
- System `arm64` → URL contains `arm64` (if mapped to `arm64`)

**Example - Terraform:**
```yaml
dependencyTemplates:
  - name: terraform
    package: terraform
    installMethod: binary-download
    checkBinary: terraform
    binaryDownload:
      url: https://releases.hashicorp.com/terraform/${{ inputs.terraform-version }}/terraform_${{ inputs.terraform-version }}_linux_$ARCH.zip
      archiveFormat: zip
      installPath: /usr/local/bin
      architectureSpecific:
        amd64: amd64
        arm64: arm64
```

**Example - Go:**
```yaml
dependencyTemplates:
  - name: go
    package: golang
    installMethod: binary-download
    checkBinary: go
    binaryDownload:
      url: https://go.dev/dl/go${{ inputs.go-version }}.linux-$ARCH.tar.gz
      archiveFormat: tar.gz
      installPath: /usr/local
      architectureSpecific:
        amd64: amd64
        arm64: arm64
    postInstall:
      - export PATH=$PATH:/usr/local/go/bin
```

### 3. Install Script

Best for tools with custom installation scripts (Google Cloud SDK, rustup, etc.).

```yaml
dependencyTemplates:
  - name: tool-name
    package: tool-name
    installMethod: install-script
    checkBinary: binary-name
    installScript:
      url: https://install.example.com
      args: --version=${{ inputs.version }} --install-dir=/usr/local
    postInstall:
      - export PATH=$PATH:/some/path
```

**Fields:**
- `installMethod`: Must be `install-script`
- `installScript.url`: URL of the installation script
- `installScript.args`: Arguments to pass to the script (supports templates)
- `postInstall`: Commands to run after installation

**Example - Google Cloud SDK:**
```yaml
dependencyTemplates:
  - name: gcloud
    package: google-cloud-sdk
    installMethod: install-script
    checkBinary: gcloud
    installScript:
      url: https://sdk.cloud.google.com
      args: --disable-prompts --install-dir=/usr/local
    postInstall:
      - export PATH=$PATH:/usr/local/google-cloud-sdk/bin
      - gcloud config set core/disable_usage_reporting true
      - gcloud config set component_manager/disable_update_check true
```

### 4. Custom Commands

For tools requiring custom installation logic, use `preInstall` and `postInstall`:

```yaml
dependencyTemplates:
  - name: tool-name
    package: tool-name
    checkBinary: binary-name
    preInstall:
      - curl -fsSL https://example.com/install.sh | bash
    postInstall:
      - export PATH=$PATH:/opt/tool/bin
      - tool init
```

## Additional Instructions

If your action needs to run commands after dependency installation, add them to `instructions`:

```yaml
instructions:
  - type: command
    command: tool --version
  - type: command
    command: tool configure --default
```

Most setup actions should have empty `instructions: []` since the dependency installation is usually sufficient.

## Best Practices

### 1. Use Appropriate Installation Method

- **Package Manager**: Node.js, Python, Ruby, system tools
- **Binary Download**: Go, Terraform, OpenTofu, compiled tools
- **Install Script**: Tools with official installers (gcloud, rustup)

### 2. Provide Sensible Defaults

Choose popular, stable versions as defaults:
```yaml
inputs:
  version:
    default: "3.11"  # Popular, LTS version
```

### 3. Include Comprehensive Descriptions

```yaml
name: Setup Python
description: Install a specific version of Python with pip and venv support

inputs:
  python-version:
    description: Python version to install (e.g., 3.8, 3.9, 3.10, 3.11)
```

### 4. Install Essential Companion Tools

Use `alternativePackages` for tools users typically need:
```yaml
alternativePackages:
  - python${{ inputs.python-version }}-dev  # Development headers
  - python${{ inputs.python-version }}-venv # Virtual environment support
  - python3-pip                              # Package manager
```

### 5. Handle Architecture Correctly

For binary downloads, always map both AMD64 and ARM64:
```yaml
architectureSpecific:
  amd64: amd64  # or x86_64, depending on URL format
  arm64: arm64  # or aarch64, depending on URL format
```

### 6. Update PATH When Needed

If the tool installs to a non-standard location, add it to PATH:
```yaml
postInstall:
  - export PATH=$PATH:/usr/local/go/bin
```

### 7. Keep Instructions Empty

Setup actions should focus on installing dependencies. Keep `instructions: []` unless you need post-install configuration.

## Sandbox kept disks

Sandbox steps with `disk_cache` set boot from the disk the step's last successful run left behind. Setup actions run again on that disk, so they must work on a fresh machine and on one that has already run them:

- Everything on the root disk comes back: installed tools, `/usr/local`, `/var/lib/docker` (images, volumes and containers). `/run` is a tmpfs and comes back empty, and that includes the Docker CLI config (`DOCKER_CONFIG=/run/ravion/docker`): buildx's list of builders and any `docker login`.
- dockerd restarts containers with a restart policy at boot, and they may still be starting when the action runs. Wait for the service inside to answer before using it (see the BuildKit wait in `docker/action.yaml`).
- `checkBinary` only checks that the binary exists, never its version. A versioned dependency needs a `verificationCommand` that compares the installed version with the input, or a kept disk keeps the old version.
- Commands run with `set -euo pipefail`. Make them idempotent: use `--rm`, or remove a fixed-name container before creating it again.

## Testing Your Action

### 1. Create a Test Workflow

```json
{
  "instructions": [
    {
      "type": "uses",
      "uses": "owner/repo/your-action@branch",
      "with": {
        "version": "1.0.0"
      }
    },
    {
      "type": "command",
      "command": "your-tool --version"
    }
  ]
}
```

### 2. Test Different Versions

Test with multiple versions to ensure template substitution works:
```json
{"version": "1.0.0"}
{"version": "2.0.0"}
{"version": "latest"}
```

### 3. Test Default Values

Test without providing any `with` parameters to verify defaults work.

### 4. Test on Different Architectures

If your action uses binary downloads, test on both AMD64 and ARM64 systems.

## File Format Support

The runner automatically tries multiple file extensions when fetching actions:

1. `action.yaml` (tried first)
2. `action.yml` (fallback)
3. `action.json` (final fallback)

**Recommendation**: Use `action.yaml` for better readability.

## Reference: Complete Field Reference

### Dependency Object

```yaml
name: string                      # Unique identifier
package: string                   # Package name (supports templates)
version: string                   # Version (supports templates)
checkBinary: string               # Binary to check for existing installation
verificationCommand: string             # Command that must exit 0 for the dependency to count as installed (overrides checkBinary)
installMethod: string             # "binary-download" | "install-script"
alternativePackages: []string     # Additional packages to install

# For binary-download method:
binaryDownload:
  url: string                     # Download URL (use $ARCH for architecture)
  archiveFormat: string           # "tar.gz" | "zip" | "tar" | "none"
  installPath: string             # Installation directory
  architectureSpecific:           # Architecture mapping
    amd64: string
    arm64: string

# For install-script method:
installScript:
  url: string                     # Script URL
  args: string                    # Script arguments (supports templates)

# Lifecycle hooks:
preInstall: []string              # Commands before installation
postInstall: []string             # Commands after installation
```

## Examples Repository

See the `examples/actions/` directory for reference implementations:

- `node/` - Package manager with version-specific packages
- `python/` - Package manager with alternative packages
- `terraform/` - Binary download with ZIP archive
- `go/` - Binary download with tar.gz and PATH update
- `gcp/` - Install script with post-install configuration
- `ruby/` - Package manager with dev tools
- `tofu/` - Binary download from GitHub releases

## Contributing

When creating new actions:

1. Create a directory under `flightcontrolhq/actions/` with your action name
2. Add an `action.yaml` file following this guide's structure
3. Test the action with different versions and parameters
4. Submit a pull request with your action and usage examples

## Need Help?

- Check existing actions in this repository for patterns
- Review the runner documentation in `packages/runner/README.md`
- Open an issue if you have questions or find bugs

