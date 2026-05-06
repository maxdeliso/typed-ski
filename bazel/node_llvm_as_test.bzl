"""Bazel rule for node_llvm_as_test."""

def _shell_dquote_literal(value):
    escaped = value.replace("\\", "\\\\")
    escaped = escaped.replace('"', '\\"')
    escaped = escaped.replace("$", "\\$")
    escaped = escaped.replace("`", "\\`")
    return escaped

def _normalize_runfiles_path(path):
    if path.startswith("../"):
        return path[3:]
    return path

def _merge_target_runfiles(runfiles, targets):
    for target in targets:
        default_info = target[DefaultInfo]
        runfiles = runfiles.merge(default_info.default_runfiles)
        runfiles = runfiles.merge(default_info.data_runfiles)
    return runfiles

def _node_llvm_as_test_impl(ctx):
    is_windows = ctx.target_platform_has_constraint(
        ctx.attr._windows_constraint[platform_common.ConstraintValueInfo],
    )
    node_toolchain = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"]
    node_path = _normalize_runfiles_path(node_toolchain.nodeinfo.node.short_path)
    llvm_as_rootpath = ctx.expand_location(
        "$(rootpath %s)" % str(ctx.attr.llvm_as.label),
        [ctx.attr.llvm_as],
    )

    extension = ".bat" if is_windows else ".sh"
    launcher = ctx.actions.declare_file(ctx.label.name + extension)

    if is_windows:
        node_bin = node_path.replace("/", "\\")
        llvm_as_path = llvm_as_rootpath.replace("/", "\\")
        content = "\r\n".join([
            "@echo off",
            "setlocal",
            "if \"%TEST_SRCDIR%\"==\"\" (",
            "  echo TEST_SRCDIR is not set.",
            "  exit /b 1",
            ")",
            "if \"%TEST_WORKSPACE%\"==\"\" (",
            "  echo TEST_WORKSPACE is not set.",
            "  exit /b 1",
            ")",
            "set \"RUNFILES_ROOT=%TEST_SRCDIR%\\%TEST_WORKSPACE%\"",
            "set \"NODE_BIN=%TEST_SRCDIR%\\" + node_bin + "\"",
            "set \"TYPED_SKI_LLVM_AS=%RUNFILES_ROOT%\\" + llvm_as_path + "\"",
            "if not exist \"%RUNFILES_ROOT%\" (",
            "  echo RUNFILES_ROOT not found: %RUNFILES_ROOT%",
            "  exit /b 1",
            ")",
            "if not exist \"%NODE_BIN%\" (",
            "  echo NODE_BIN not found: %NODE_BIN%",
            "  exit /b 1",
            ")",
            "if not exist \"%TYPED_SKI_LLVM_AS%\" (",
            "  echo TYPED_SKI_LLVM_AS not found: %TYPED_SKI_LLVM_AS%",
            "  exit /b 1",
            ")",
            "cd /d \"%RUNFILES_ROOT%\"",
            "if not \"%TEST_SHARD_STATUS_FILE%\"==\"\" type nul > \"%TEST_SHARD_STATUS_FILE%\"",
            "\"%NODE_BIN%\" \"--experimental-transform-types\" \"--preserve-symlinks\" \"--test\" \"--enable-source-maps\" \"test/compiler/llvm/llvmAsSmoke.test.ts\"",
            "exit /b %ERRORLEVEL%",
            "",
        ])
    else:
        node_bin = _shell_dquote_literal(node_path)
        llvm_as_path = _shell_dquote_literal(llvm_as_rootpath)
        content = "\n".join([
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "if [[ -z \"${TEST_SRCDIR:-}\" ]]; then",
            "  echo \"TEST_SRCDIR is not set.\" >&2",
            "  exit 1",
            "fi",
            "if [[ -z \"${TEST_WORKSPACE:-}\" ]]; then",
            "  echo \"TEST_WORKSPACE is not set.\" >&2",
            "  exit 1",
            "fi",
            "runfiles_root=\"${TEST_SRCDIR}/${TEST_WORKSPACE}\"",
            "node_bin=\"${TEST_SRCDIR}/" + node_bin + "\"",
            "export TYPED_SKI_LLVM_AS=\"$runfiles_root/" + llvm_as_path + "\"",
            "if [[ ! -d \"$runfiles_root\" ]]; then",
            "  echo \"RUNFILES_ROOT not found: $runfiles_root\" >&2",
            "  exit 1",
            "fi",
            "if [[ ! -f \"$node_bin\" ]]; then",
            "  echo \"NODE_BIN not found: $node_bin\" >&2",
            "  exit 1",
            "fi",
            "if [[ ! -f \"$TYPED_SKI_LLVM_AS\" ]]; then",
            "  echo \"TYPED_SKI_LLVM_AS not found: $TYPED_SKI_LLVM_AS\" >&2",
            "  exit 1",
            "fi",
            "cd \"$runfiles_root\"",
            "[[ -n \"${TEST_SHARD_STATUS_FILE:-}\" ]] && touch \"$TEST_SHARD_STATUS_FILE\"",
            "\"$node_bin\" --experimental-transform-types --preserve-symlinks --test --enable-source-maps test/compiler/llvm/llvmAsSmoke.test.ts",
            "",
        ])

    ctx.actions.write(launcher, content, is_executable = True)

    runfiles = ctx.runfiles(
        files = ctx.files.data + [node_toolchain.nodeinfo.node, ctx.file.llvm_as],
    )
    runfiles = _merge_target_runfiles(runfiles, ctx.attr.data)
    runfiles = runfiles.merge(ctx.attr.llvm_as[DefaultInfo].default_runfiles)
    runfiles = runfiles.merge(ctx.attr.llvm_as[DefaultInfo].data_runfiles)

    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

node_llvm_as_test = rule(
    implementation = _node_llvm_as_test_impl,
    attrs = {
        "data": attr.label_list(
            allow_files = True,
        ),
        "llvm_as": attr.label(
            allow_single_file = True,
            mandatory = True,
        ),
        "_windows_constraint": attr.label(
            default = "@platforms//os:windows",
        ),
    },
    executable = True,
    test = True,
    toolchains = ["@rules_nodejs//nodejs:toolchain_type"],
)
