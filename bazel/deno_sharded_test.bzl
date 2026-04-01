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

def _deno_sharded_test_impl(ctx):
    is_windows = ctx.target_platform_has_constraint(
        ctx.attr._windows_constraint[platform_common.ConstraintValueInfo],
    )
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
    dist_bin_name = "tripc.exe" if is_windows else "tripc"
    dist_js_rootpath = dist_files["tripc.js"].short_path
    dist_min_js_rootpath = dist_files["tripc.min.js"].short_path
    dist_node_js_rootpath = dist_files["tripc.node.js"].short_path
    dist_bin_rootpath = dist_files[dist_bin_name].short_path

    if is_windows:
        command = " ".join([
            _batch_quote("deno"),
            _batch_quote("run"),
            _batch_quote("-A"),
            _batch_quote("scripts/withRepoDeno.ts"),
            _batch_quote("run"),
            _batch_quote("-A"),
            _batch_quote("scripts/bazelShardTest.ts"),
        ])
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
            "cd /d \"%RUNFILES_ROOT%\"",
            "set \"THANATOS_BIN=%RUNFILES_ROOT%\\" + thanatos_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_WASM_PATH=%RUNFILES_ROOT%\\" + wasm_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_JS_PATH=%RUNFILES_ROOT%\\" + dist_js_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_MIN_JS_PATH=%RUNFILES_ROOT%\\" + dist_min_js_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_NODE_JS_PATH=%RUNFILES_ROOT%\\" + dist_node_js_rootpath.replace("/", "\\") + "\"",
            "set \"TYPED_SKI_DIST_BIN_PATH=%RUNFILES_ROOT%\\" + dist_bin_rootpath.replace("/", "\\") + "\"",
            command,
            "exit /b %ERRORLEVEL%",
            "",
        ])
    else:
        command = " ".join([
            _shell_quote("deno"),
            _shell_quote("run"),
            _shell_quote("-A"),
            _shell_quote("scripts/withRepoDeno.ts"),
            _shell_quote("run"),
            _shell_quote("-A"),
            _shell_quote("scripts/bazelShardTest.ts"),
        ])
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
            "cd \"$runfiles_root\"",
            "export THANATOS_BIN=\"$runfiles_root/" + _shell_dquote_literal(thanatos_rootpath) + "\"",
            "export TYPED_SKI_WASM_PATH=\"$runfiles_root/" + _shell_dquote_literal(wasm_rootpath) + "\"",
            "export TYPED_SKI_DIST_JS_PATH=\"$runfiles_root/" + _shell_dquote_literal(dist_js_rootpath) + "\"",
            "export TYPED_SKI_DIST_MIN_JS_PATH=\"$runfiles_root/" + _shell_dquote_literal(dist_min_js_rootpath) + "\"",
            "export TYPED_SKI_DIST_NODE_JS_PATH=\"$runfiles_root/" + _shell_dquote_literal(dist_node_js_rootpath) + "\"",
            "export TYPED_SKI_DIST_BIN_PATH=\"$runfiles_root/" + _shell_dquote_literal(dist_bin_rootpath) + "\"",
            command,
            "",
        ])

    ctx.actions.write(launcher, content, is_executable = True)

    runfiles = ctx.runfiles(
        files = ctx.files.data + [ctx.executable.thanatos, ctx.file.wasm] + ctx.attr.dist[DefaultInfo].files.to_list(),
    )
    runfiles = runfiles.merge(ctx.attr.thanatos[DefaultInfo].default_runfiles)
    runfiles = runfiles.merge(ctx.attr.wasm[DefaultInfo].default_runfiles)
    runfiles = runfiles.merge(ctx.attr.dist[DefaultInfo].default_runfiles)

    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

deno_sharded_test = rule(
    implementation = _deno_sharded_test_impl,
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
)
