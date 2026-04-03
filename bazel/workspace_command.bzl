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
    node_path = node_toolchain.nodeinfo.target_tool_path
    
    extension = ".bat" if is_windows else ".sh"
    launcher = ctx.actions.declare_file(ctx.label.name + extension)
    args = [ctx.attr.subcommand] + ctx.attr.command_args

    if is_windows:
        command = " ".join(
            [_batch_quote(node_path), _batch_quote("--experimental-transform-types"), _batch_quote("scripts/bazel.ts")] +
            [_batch_quote(arg) for arg in args]
        ) + " %*"
        content = "\r\n".join([
            "@echo off",
            "setlocal",
            "if \"%BUILD_WORKSPACE_DIRECTORY%\"==\"\" (",
            "  echo BUILD_WORKSPACE_DIRECTORY is not set. Use bazel run for this target.",
            "  exit /b 1",
            ")",
            "cd /d \"%BUILD_WORKSPACE_DIRECTORY%\"",
            command,
            "exit /b %ERRORLEVEL%",
            "",
        ])
    else:
        command = " ".join(
            [_shell_quote(node_path), _shell_quote("--experimental-transform-types"), _shell_quote("scripts/bazel.ts")] +
            [_shell_quote(arg) for arg in args]
        ) + " \"$@\""
        content = "\n".join([
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "if [[ -z \"${BUILD_WORKSPACE_DIRECTORY:-}\" ]]; then",
            "  echo \"BUILD_WORKSPACE_DIRECTORY is not set. Use bazel run for this target.\" >&2",
            "  exit 1",
            "fi",
            "cd \"$BUILD_WORKSPACE_DIRECTORY\"",
            command,
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
