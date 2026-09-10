{
  description = "camris-tools dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-24.11-darwin";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          # _1password-cli is unfree; allow only that one package.
          config.allowUnfreePredicate = pkg:
            builtins.elem (nixpkgs.lib.getName pkg) [ "1password-cli" ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_20      # match CI (ci.yml / deploy.yml use Node 20)
            pkgs.gh
            pkgs._1password-cli # `op`, for pulling GH_TOKEN from 1Password
          ];
        };
      });
}
