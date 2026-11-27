{
  fetchFromGitHub,
  git,
  installShellFiles,
  lib,
  makeBinaryWrapper,
  rustPlatform,
  stdenv,
}:
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "git-twig";
  version = "0.6.0";

  src = fetchFromGitHub {
    owner = "leostera";
    repo = "git-twig";
    tag = "v${finalAttrs.version}";
    hash = "sha256-5S8GKjyvskp/UXn7sHE6oM0YPcA/VCyr6YM/0f2j6Hg=";
  };

  cargoHash = "sha256-0xfBc0LUaaBwnVVzkFd25B4uRdv6XsmGEKjzIVWCK3I=";
  cargoBuildFlags = [
    "--package"
    "git-twig"
  ];

  nativeBuildInputs = [
    installShellFiles
    makeBinaryWrapper
  ];
  nativeCheckInputs = [ git ];
  # The bench crate needs network fixtures; only the CLI's own suite runs.
  cargoTestFlags = [
    "--package"
    "git-twig"
  ];
  # These call macOS-only tools (`chmod +a`, resource forks) that the sandbox
  # PATH replaces with coreutils.
  checkFlags = map (t: "--skip=${t}") (
    [
      "adopt_compact::inherited_recovery_acl_is_refused_before_worktrees_move"
      "adopt_compact::odd_names_resource_forks_hardlinks_and_symlinks_survive"
      "adopt::inspection_and_preparation_preserve_existing_dirty_staged_worktrees"
      "adopt_compact::offline_compaction_preserves_target_metadata_and_dirty_staged_bytes"
      "staging_cleanup::inherited_acl_entries_match_git"
    ]
    # The Linux sandbox's seccomp filter refuses setgid mode bits (EPERM), and
    # it has no /bin/cat, which this test runs by absolute path.
    ++ lib.optionals stdenv.hostPlatform.isLinux [
      "destination_setgid_directories_match_git"
      "staging_cleanup::paths_too_long_for_staging_still_create_and_leave_no_scratch"
    ]
  );

  postInstall = ''
    installManPage crates/git-twig/man/git-twig.1
    # Harnesses link the bundled skill from here (cli/agents/skills.nix).
    mkdir -p $out/share/git-twig
    cp -r crates/git-twig/skills $out/share/git-twig/
    # Twig shells out to git; Git 2.40+ is required, so pin ours.
    wrapProgram $out/bin/git-twig --prefix PATH : ${lib.makeBinPath [ git ]}
  '';

  meta = {
    description = "Linked Git worktrees using native copy-on-write";
    homepage = "https://github.com/leostera/git-twig";
    license = lib.licenses.mit;
    mainProgram = "git-twig";
  };
})
