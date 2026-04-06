def _shell_quote(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"

def _batch_quote(value):
    escaped = value.replace("^", "^^")
    escaped = escaped.replace("%", "%%")
    escaped = escaped.replace('"', '""')
    return '"' + escaped + '"'

def _workspace_command_impl(ctx):
    is_windows = ctx.target_platform_has_constraint(
        ctx.attr._windows_constraint[platform_common.ConstraintValueInfo],
    )
    node_toolchain = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"]
    node_file = node_toolchain.nodeinfo.node
    node_short_path = node_file.short_path
    if node_short_path.startswith("../"):
        node_short_path = node_short_path[3:]

    extension = ".bat" if is_windows else ".sh"
    launcher = ctx.actions.declare_file(ctx.label.name + extension)
    args = [ctx.attr.subcommand] + ctx.attr.command_args

    if is_windows:
        content = "\r\n".join([
            "@echo off",
            "setlocal",
            "if \"%BUILD_WORKSPACE_DIRECTORY%\"==\"\" (",
            "  echo BUILD_WORKSPACE_DIRECTORY is not set. Use bazel run for this target.",
            "  exit /b 1",
            ")",
            "set \"NODE_BIN=" + node_short_path.replace("/", "\\") + "\"",
            "if not exist \"%NODE_BIN%\" if exist \"..\\%NODE_BIN%\" set \"NODE_BIN=..\\%NODE_BIN%\"",
            "if not exist \"%NODE_BIN%\" if exist \"MANIFEST\" (",
            "  for /f \"tokens=1,2\" %%a in (MANIFEST) do (",
            "    if \"%%a\"==\"" + node_short_path + "\" set \"NODE_BIN=%%b\"",
            "  )",
            ")",
            "if not exist \"%NODE_BIN%\" (",
            "  echo node binary not found in runfiles",
            "  exit /b 1",
            ")",
            "for /f \"delims=\" %%i in (\"%NODE_BIN%\") do set \"NODE_BIN=%%~fi\"",
            "cd /d \"%BUILD_WORKSPACE_DIRECTORY%\"",
            "\"%NODE_BIN%\" \"--experimental-transform-types\" \"scripts/bazel.ts\" " + " ".join([_batch_quote(arg) for arg in args]) + " %*",
            "exit /b %ERRORLEVEL%",
            "",
        ])
    else:
        content = "\n".join([
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "if [[ -z \"${BUILD_WORKSPACE_DIRECTORY:-}\" ]]; then",
            "  echo \"BUILD_WORKSPACE_DIRECTORY is not set. Use bazel run for this target.\" >&2",
            "  exit 1",
            "fi",
            "NODE_BIN=" + _shell_quote(node_short_path),
            "if [[ ! -f \"$NODE_BIN\" ]]; then",
            "  NODE_BIN=\"../$NODE_BIN\"",
            "fi",
            "if [[ ! -f \"$NODE_BIN\" ]] && [[ -f MANIFEST ]]; then",
            "  NODE_BIN=$(grep \"^" + node_short_path + " \" MANIFEST | cut -f2- -d' ')",
            "fi",
            "if [[ -z \"$NODE_BIN\" ]] || [[ ! -f \"$NODE_BIN\" ]]; then",
            "  echo \"node binary not found in runfiles\" >&2",
            "  exit 1",
            "fi",
            "NODE_BIN=$(cd \"$(dirname \"$NODE_BIN\")\" && pwd)/$(basename \"$NODE_BIN\")",
            "cd \"$BUILD_WORKSPACE_DIRECTORY\"",
            "\"$NODE_BIN\" --experimental-transform-types scripts/bazel.ts " + " ".join([_shell_quote(arg) for arg in args]) + " \"$@\"",
            "",
        ])
    ctx.actions.write(launcher, content, is_executable = True)
    
    runfiles = ctx.runfiles(files = [node_toolchain.nodeinfo.node])
    
    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

workspace_command = rule(
    implementation = _workspace_command_impl,
    attrs = {
        "command_args": attr.string_list(),
        "subcommand": attr.string(mandatory = True),
        "_windows_constraint": attr.label(
            default = "@platforms//os:windows",
        ),
    },
    executable = True,
    toolchains = ["@rules_nodejs//nodejs:toolchain_type"],
)
