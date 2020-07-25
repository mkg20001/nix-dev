# nix-dev

CLI for managing FHS environments on nixOS

> WIP

# Usage

```
Commands:
  dev add [pkgs..]   add one or more packages
  dev rm [pkgs..]    remove one or more packages
  dev rebuild [env]  rebuild an environment
  dev update [env]   update an environment
  dev enter [env]    enter an environment                              [default]

Options:
  --version      Show version number                                   [boolean]
  --env, -e      Environment to use                [string] [default: "default"]
  --rebuild, -r  Rebuild automatically (disable: --no-rebuild)
                                                       [boolean] [default: true]
  --verbose, -v  Run with verbose logging                              [boolean]
  --help         Show help                                             [boolean]
```
