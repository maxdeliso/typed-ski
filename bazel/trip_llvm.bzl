def _normalize_runfiles_path(path):
    if path.startswith("../"):
        return path[3:]
    return path

def _powershell_dquote_literal(value):
    escaped = value.replace("`", "``")
    escaped = escaped.replace("$", "`$")
    escaped = escaped.replace('"', '`"')
    escaped = escaped.replace("\r", "`r")
    escaped = escaped.replace("\n", "`n")
    return '"' + escaped + '"'

def _sh_single_quote_literal(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"

def _merge_target_runfiles(runfiles, targets):
    for target in targets:
        default_info = target[DefaultInfo]
        runfiles = runfiles.merge(default_info.default_runfiles)
        runfiles = runfiles.merge(default_info.data_runfiles)
    return runfiles

def _trip_llvm_object_impl(ctx):
    if len(ctx.attr.module_source_names) != len(ctx.files.module_source_files):
        fail("module_source_names and module_source_files must have the same length")

    node_toolchain = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"]
    llvm_ir = ctx.actions.declare_file(ctx.label.name + ".ll")
    obj = ctx.actions.declare_file(ctx.label.name + ctx.attr.object_extension)

    emit_args = ctx.actions.args()
    emit_args.add("--experimental-transform-types")
    emit_args.add(ctx.file._script)
    emit_args.add("--input")
    emit_args.add(ctx.file.src)
    emit_args.add("--output")
    emit_args.add(llvm_ir)
    emit_args.add("--target")
    emit_args.add(ctx.attr.target_triple)
    if ctx.attr.entry_module:
        emit_args.add("--entry-module")
        emit_args.add(ctx.attr.entry_module)
    if ctx.attr.emit_main_wrapper:
        emit_args.add("--emit-main-wrapper")

    for index, module_name in enumerate(ctx.attr.module_source_names):
        module_file = ctx.files.module_source_files[index]
        emit_args.add("--module-source")
        emit_args.add("{}={}".format(module_name, module_file.path))

    ctx.actions.run(
        executable = node_toolchain.nodeinfo.node,
        arguments = [emit_args],
        inputs = depset(
            ctx.files.data +
            ctx.files.module_source_files +
            [
                ctx.file.src,
                ctx.file._script,
                node_toolchain.nodeinfo.node,
            ],
        ),
        outputs = [llvm_ir],
        mnemonic = "TripLlvmIr",
        progress_message = "Lowering %s to LLVM IR" % ctx.file.src.short_path,
        use_default_shell_env = True,
    )

    llc_args = ctx.actions.args()
    llc_args.add("-mtriple={}".format(ctx.attr.target_triple))
    llc_args.add("-filetype=obj")
    llc_args.add(llvm_ir)
    llc_args.add("-o")
    llc_args.add(obj)

    ctx.actions.run(
        executable = ctx.executable.llvm_llc,
        arguments = [llc_args],
        inputs = depset([llvm_ir]),
        tools = depset([ctx.executable.llvm_llc] + ctx.files.llvm_dist),
        outputs = [obj],
        mnemonic = "TripLlvmObject",
        progress_message = "Compiling %s to native object" % llvm_ir.short_path,
        use_default_shell_env = True,
    )

    return [DefaultInfo(files = depset([obj]))]

trip_llvm_object = rule(
    implementation = _trip_llvm_object_impl,
    attrs = {
        "data": attr.label_list(allow_files = True),
        "emit_main_wrapper": attr.bool(default = True),
        "entry_module": attr.string(default = ""),
        "llvm_dist": attr.label_list(
            allow_files = True,
            cfg = "exec",
        ),
        "llvm_llc": attr.label(
            allow_single_file = True,
            cfg = "exec",
            executable = True,
            mandatory = True,
        ),
        "module_source_files": attr.label_list(allow_files = True),
        "module_source_names": attr.string_list(),
        "object_extension": attr.string(default = ".obj"),
        "src": attr.label(
            allow_single_file = [".trip"],
            mandatory = True,
        ),
        "target_triple": attr.string(default = "x86_64-pc-windows-msvc"),
        "_script": attr.label(
            allow_single_file = True,
            default = "//scripts:trip_to_llvm.ts",
        ),
    },
    toolchains = ["@rules_nodejs//nodejs:toolchain_type"],
)

def _trip_executable_stdout_test_impl(ctx):
    is_windows = ctx.target_platform_has_constraint(
        ctx.attr._windows_constraint[platform_common.ConstraintValueInfo],
    )
    is_linux = ctx.target_platform_has_constraint(
        ctx.attr._linux_constraint[platform_common.ConstraintValueInfo],
    )
    if not is_windows and not is_linux:
        fail("trip_executable_stdout_test only supports Windows and Linux; add target_compatible_with to the target.")

    binary_rootpath = ctx.expand_location(
        "$(rootpath %s)" % str(ctx.attr.binary.label),
        [ctx.attr.binary],
    )
    if is_windows:
        binary_path = binary_rootpath.replace("/", "\\")
        ps_script = ctx.actions.declare_file(ctx.label.name + ".ps1")
        launcher = ctx.actions.declare_file(ctx.label.name + ".bat")

        ps_content = "\r\n".join([
            '$ErrorActionPreference = "Stop"',
            "$exe = $args[0]",
            "$expected = " + _powershell_dquote_literal(ctx.attr.expected_stdout),
            "$expectedExitCode = " + str(ctx.attr.expected_exit_code),
            "if (-not (Test-Path -LiteralPath $exe)) {",
            "  # If not found directly, try to resolve via manifest",
            '  $manifest = $env:RUNFILES_MANIFEST_FILE',
            "  if ($manifest -and (Test-Path -LiteralPath $manifest)) {",
            '    $mapping = Get-Content -LiteralPath $manifest | Where-Object { $_ -match "^[^ ]+ $([regex]::Escape($exe))(?=`$| )" }',
            "    if ($mapping) {",
            '      $exe = $mapping.Split(" ")[1]',
            "    }",
            "  }",
            "}",
            "if (-not (Test-Path -LiteralPath $exe)) {",
            '  Write-Error "Executable not found: $exe"',
            "  exit 1",
            "}",
            "$process = [System.Diagnostics.Process]::new()",
            "$process.StartInfo.FileName = $exe",
            "$process.StartInfo.UseShellExecute = $false",
            "$process.StartInfo.RedirectStandardOutput = $true",
            "$process.StartInfo.RedirectStandardError = $true",
            "$process.StartInfo.CreateNoWindow = $true",
            "[void]$process.Start()",
            "$stdout = $process.StandardOutput.ReadToEnd()",
            "$stderr = $process.StandardError.ReadToEnd()",
            "$process.WaitForExit()",
            "if ($process.ExitCode -ne $expectedExitCode) {",
            '  Write-Error "Executable exited with code $($process.ExitCode). Expected: $expectedExitCode. stderr: $stderr"',
            "  exit 1",
            "}",
            "if ($stdout -ne $expected) {",
            '  Write-Error "Unexpected stdout. Expected: <$expected> Actual: <$stdout>"',
            "  exit 1",
            "}",
            "if ($stderr.Length -ne 0) {",
            '  Write-Host "stderr: $stderr"',
            "}",
            "exit 0",
            "",
        ])
        ctx.actions.write(ps_script, ps_content)

        ps_path = _normalize_runfiles_path(ps_script.short_path).replace("/", "\\")
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
            "set \"TRIP_TEST_BINARY=%RUNFILES_ROOT%\\" + binary_path + "\"",
            "set \"TRIP_TEST_SCRIPT=%RUNFILES_ROOT%\\" + ps_path + "\"",
            "if not exist \"%RUNFILES_ROOT%\" (",
            "  echo RUNFILES_ROOT not found: %RUNFILES_ROOT%",
            "  exit /b 1",
            ")",
            "if not exist \"%TRIP_TEST_BINARY%\" (",
            "  echo TRIP_TEST_BINARY not found: %TRIP_TEST_BINARY%",
            "  exit /b 1",
            ")",
            "if not exist \"%TRIP_TEST_SCRIPT%\" (",
            "  echo TRIP_TEST_SCRIPT not found: %TRIP_TEST_SCRIPT%",
            "  exit /b 1",
            ")",
            "if not \"%TEST_SHARD_STATUS_FILE%\"==\"\" type nul > \"%TEST_SHARD_STATUS_FILE%\"",
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%TRIP_TEST_SCRIPT%\" \"%TRIP_TEST_BINARY%\"",
            "exit /b %ERRORLEVEL%",
            "",
        ])
        ctx.actions.write(launcher, content, is_executable = True)
        runfiles = ctx.runfiles(files = [ctx.executable.binary, ps_script])
    else:
        launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
        content = "\n".join([
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "binary=" + _sh_single_quote_literal(binary_rootpath),
            "expected=" + _sh_single_quote_literal(ctx.attr.expected_stdout),
            "expected_exit_code=" + str(ctx.attr.expected_exit_code),
            "if [[ ! -x \"$binary\" && -n \"${TEST_SRCDIR:-}\" && -n \"${TEST_WORKSPACE:-}\" ]]; then",
            "  candidate=\"$TEST_SRCDIR/$TEST_WORKSPACE/$binary\"",
            "  if [[ -x \"$candidate\" ]]; then",
            "    binary=\"$candidate\"",
            "  fi",
            "fi",
            "if [[ ! -x \"$binary\" ]]; then",
            "  echo \"Executable not found: $binary\" >&2",
            "  exit 1",
            "fi",
            "stdout_file=\"$(mktemp)\"",
            "stderr_file=\"$(mktemp)\"",
            "trap 'rm -f \"$stdout_file\" \"$stderr_file\"' EXIT",
            "code=0",
            "if \"$binary\" >\"$stdout_file\" 2>\"$stderr_file\"; then",
            "  code=0",
            "else",
            "  code=$?",
            "fi",
            "if [[ $code -ne $expected_exit_code ]]; then",
            "  echo \"Executable exited with code $code. Expected: $expected_exit_code. stderr:\" >&2",
            "  cat \"$stderr_file\" >&2",
            "  exit 1",
            "fi",
            "stdout=\"$(cat \"$stdout_file\")\"",
            "stdout=\"$stdout\"$'\\n'",
            "if [[ \"$stdout\" != \"$expected\" ]]; then",
            "  printf 'Unexpected stdout. Expected: <%s> Actual: <%s>\\n' \"$expected\" \"$stdout\" >&2",
            "  exit 1",
            "fi",
            "if [[ -s \"$stderr_file\" ]]; then",
            "  cat \"$stderr_file\"",
            "fi",
            "",
        ])
        ctx.actions.write(launcher, content, is_executable = True)
        runfiles = ctx.runfiles(files = [ctx.executable.binary])

    runfiles = _merge_target_runfiles(runfiles, [ctx.attr.binary])
    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

trip_executable_stdout_test = rule(
    implementation = _trip_executable_stdout_test_impl,
    attrs = {
        "binary": attr.label(
            cfg = "target",
            executable = True,
            mandatory = True,
        ),
        "expected_exit_code": attr.int(default = 0),
        "expected_stdout": attr.string(mandatory = True),
        "_linux_constraint": attr.label(
            default = "@platforms//os:linux",
        ),
        "_windows_constraint": attr.label(
            default = "@platforms//os:windows",
        ),
    },
    executable = True,
    test = True,
)
