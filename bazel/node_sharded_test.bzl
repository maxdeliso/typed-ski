def _shell_quote(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"

def _shell_dquote_literal(value):
    escaped = value.replace("\\", "\\\\")
    escaped = escaped.replace('"', '\\"')
    escaped = escaped.replace("$", "\\$")
    escaped = escaped.replace("`", "\\`")
    return escaped

def _batch_quote(value):
    escaped = value.replace("^", "^^")
    escaped = escaped.replace("%", "%%")
    escaped = escaped.replace('"', '""')
    return '"' + escaped + '"'

def _normalize_runfiles_path(path):
    if path.startswith("../"):
        return path[3:]
    return path

def _node_sharded_test_impl(ctx):
    is_windows = ctx.target_platform_has_constraint(
        ctx.attr._windows_constraint[platform_common.ConstraintValueInfo],
    )
    node_toolchain = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"]
    node_path = _normalize_runfiles_path(node_toolchain.nodeinfo.node.short_path)

    extension = ".bat" if is_windows else ".sh"
    launcher = ctx.actions.declare_file(ctx.label.name + extension)

    thanatos_rootpath = ctx.expand_location(
        "$(rootpath %s)" % str(ctx.attr.thanatos.label),
        [ctx.attr.thanatos],
    )
    wasm_rootpath = ctx.expand_location(
        "$(rootpath %s)" % str(ctx.attr.wasm.label),
        [ctx.attr.wasm],
    )
    dist_files = {f.basename: f for f in ctx.attr.dist[DefaultInfo].files.to_list()}
    dist_bin_name = "tripc.cmd" if is_windows else "tripc"
    arena_worker_js_rootpath = dist_files["arenaWorker.js"].short_path
    dist_js_rootpath = dist_files["tripc.js"].short_path
    dist_min_js_rootpath = dist_files["tripc.min.js"].short_path
    dist_node_js_rootpath = dist_files["tripc.node.js"].short_path
    dist_bin_rootpath = dist_files[dist_bin_name].short_path

    if is_windows:
        node_bin = node_path.replace("/", "\\")
        command = "\"%NODE_BIN%\" \"--experimental-transform-types\" \"--preserve-symlinks\" \"scripts/bazel.ts\" \"bazel-test-shard\" %*"
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
            "if not exist \"%RUNFILES_ROOT%\" (",
            "  echo RUNFILES_ROOT not found: %RUNFILES_ROOT%",
            "  exit /b 1",
            ")",
            "if not exist \"%NODE_BIN%\" (",
            "  echo NODE_BIN not found: %NODE_BIN%",
            "  exit /b 1",
            ")",
            "cd /d \"%RUNFILES_ROOT%\"",
            "if not exist \"scripts\\bazel.ts\" (",
            "  echo bazel.ts not found under %RUNFILES_ROOT%",
            "  exit /b 1",
            ")",
            "set \"THANATOS_BIN=%RUNFILES_ROOT%\\" + thanatos_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_WASM_PATH=%RUNFILES_ROOT%\\" + wasm_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_JS_PATH=%RUNFILES_ROOT%\\" + dist_js_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_MIN_JS_PATH=%RUNFILES_ROOT%\\" + dist_min_js_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_NODE_JS_PATH=%RUNFILES_ROOT%\\" + dist_node_js_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_ARENA_WORKER_JS_PATH=%RUNFILES_ROOT%\\" + arena_worker_js_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_BIN_PATH=%RUNFILES_ROOT%\\" + dist_bin_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_READY=1\"",
            "if not \"%TEST_SHARD_STATUS_FILE%\"==\"\" type nul > \"%TEST_SHARD_STATUS_FILE%\"",
            command,
            "exit /b %ERRORLEVEL%",
            "",
        ])
    else:
        node_bin = _shell_dquote_literal(node_path)
        command = "\"$node_bin\" --experimental-transform-types --preserve-symlinks scripts/bazel.ts bazel-test-shard \"$@\""
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
            "if [[ ! -d \"$runfiles_root\" ]]; then",
            "  echo \"RUNFILES_ROOT not found: $runfiles_root\" >&2",
            "  exit 1",
            "fi",
            "if [[ ! -f \"$node_bin\" ]]; then",
            "  echo \"NODE_BIN not found: $node_bin\" >&2",
            "  exit 1",
            "fi",
            "cd \"$runfiles_root\"",
            "if [[ ! -f \"scripts/bazel.ts\" ]]; then",
            "  echo \"bazel.ts not found under $runfiles_root\" >&2",
            "  exit 1",
            "fi",
            "export THANATOS_BIN=\"$runfiles_root/" + _shell_dquote_literal(thanatos_rootpath) + "\"",
            "export TYPED_SKI_WASM_PATH=\"$runfiles_root/" + _shell_dquote_literal(wasm_rootpath) + "\"",
            "export TYPED_SKI_DIST_JS_PATH=\"$runfiles_root/" + _shell_dquote_literal(dist_js_rootpath) + "\"",
            "export TYPED_SKI_DIST_MIN_JS_PATH=\"$runfiles_root/" + _shell_dquote_literal(dist_min_js_rootpath) + "\"",
            "export TYPED_SKI_DIST_NODE_JS_PATH=\"$runfiles_root/" + _shell_dquote_literal(dist_node_js_rootpath) + "\"",
            "export TYPED_SKI_ARENA_WORKER_JS_PATH=\"$runfiles_root/" + _shell_dquote_literal(arena_worker_js_rootpath) + "\"",
            "export TYPED_SKI_DIST_BIN_PATH=\"$runfiles_root/" + _shell_dquote_literal(dist_bin_rootpath) + "\"",
            "export TYPED_SKI_DIST_READY=1",
            "[[ -n \"${TEST_SHARD_STATUS_FILE:-}\" ]] && touch \"$TEST_SHARD_STATUS_FILE\"",
            command,
            "",
        ])

    ctx.actions.write(launcher, content, is_executable = True)

    runfiles = ctx.runfiles(
        files = ctx.files.data + [ctx.executable.thanatos, ctx.file.wasm, node_toolchain.nodeinfo.node] + ctx.attr.dist[DefaultInfo].files.to_list(),
    )
    runfiles = runfiles.merge(ctx.attr.thanatos[DefaultInfo].default_runfiles)
    runfiles = runfiles.merge(ctx.attr.wasm[DefaultInfo].default_runfiles)
    runfiles = runfiles.merge(ctx.attr.dist[DefaultInfo].default_runfiles)

    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

node_sharded_test = rule(
    implementation = _node_sharded_test_impl,
    attrs = {
        "data": attr.label_list(
            allow_files = True,
        ),
        "dist": attr.label(
            mandatory = True,
        ),
        "thanatos": attr.label(
            executable = True,
            cfg = "target",
            mandatory = True,
        ),
        "wasm": attr.label(
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
