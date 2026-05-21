load("//bazel:common.bzl", "normalize_runfiles_path", "powershell_dquote_literal", "sh_single_quote_literal", "merge_target_runfiles")

def _single_output_file(target, attr_name):
    files = target[DefaultInfo].files.to_list()
    if len(files) != 1:
        fail("{} must produce exactly one file, got {}".format(attr_name, len(files)))
    return files[0]

def _trip_llvm_object_impl(ctx):
    if len(ctx.attr.module_source_names) != len(ctx.files.module_source_files):
        fail("module_source_names and module_source_files must have the same length")

    llvm_ir = ctx.actions.declare_file(ctx.label.name + ".ll")
    obj = ctx.actions.declare_file(ctx.label.name + ctx.attr.object_extension)

    tripc_js = ctx.file.compiler

    module_args = []
    for index, module_name in enumerate(ctx.attr.module_source_names):
        module_file = ctx.files.module_source_files[index]
        module_args.append("--module-source")
        module_args.append("{}={}".format(module_name, module_file.path))

    args = [
        tripc_js.path,
        "--emit",
        "llvm",
        ctx.file.src.path,
        llvm_ir.path,
        "--target",
        ctx.attr.target_triple,
    ]
    if ctx.attr.entry_module:
        args.extend(["--entry-module", ctx.attr.entry_module])
    if ctx.attr.emit_main_wrapper:
        args.append("--emit-main-wrapper")
    args.extend(module_args)

    ctx.actions.run(
        executable = "node",
        arguments = args,
        inputs = depset(
            ctx.files.module_source_files +
            [
                ctx.file.src,
                tripc_js,
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
        "compiler": attr.label(
            allow_single_file = True,
            mandatory = True,
        ),
    },
)

def _windows_import_library_impl(ctx):
    import_lib = ctx.actions.declare_file(ctx.label.name + ".lib")

    args = ctx.actions.args()
    args.add("-m")
    args.add("i386:x86-64")
    args.add("-d")
    args.add(ctx.file.def_file)
    args.add("-l")
    args.add(import_lib)

    ctx.actions.run(
        executable = ctx.executable.llvm_dlltool,
        arguments = [args],
        inputs = [ctx.file.def_file],
        tools = [ctx.executable.llvm_dlltool],
        outputs = [import_lib],
        mnemonic = "TripWindowsImportLib",
        progress_message = "Generating Windows import library %s" % import_lib.short_path,
    )

    return [DefaultInfo(files = depset([import_lib]))]

windows_import_library = rule(
    implementation = _windows_import_library_impl,
    attrs = {
        "def_file": attr.label(
            allow_single_file = [".def"],
            mandatory = True,
        ),
        "llvm_dlltool": attr.label(
            allow_single_file = True,
            cfg = "exec",
            executable = True,
            mandatory = True,
        ),
    },
)

def _trip_windows_executable_impl(ctx):
    trip_obj = _single_output_file(ctx.attr.object, "object")
    runtime_obj = ctx.actions.declare_file(ctx.label.name + "_runtime.obj")
    exe = ctx.actions.declare_file(ctx.label.name + ".exe")
    import_libs = [_single_output_file(lib, "import_libs") for lib in ctx.attr.import_libs]

    runtime_args = ctx.actions.args()
    runtime_args.add("-mtriple=x86_64-pc-windows-msvc")
    runtime_args.add("-filetype=obj")
    runtime_args.add(ctx.file.runtime_llvm)
    runtime_args.add("-o")
    runtime_args.add(runtime_obj)

    ctx.actions.run(
        executable = ctx.executable.llvm_llc,
        arguments = [runtime_args],
        inputs = [ctx.file.runtime_llvm],
        tools = depset([ctx.executable.llvm_llc] + ctx.files.llvm_dist),
        outputs = [runtime_obj],
        mnemonic = "TripWindowsRuntimeObject",
        progress_message = "Compiling no-CRT Windows runtime %s" % ctx.file.runtime_llvm.short_path,
    )

    link_args = ctx.actions.args()
    link_args.add("/NOLOGO")
    link_args.add("/MACHINE:X64")
    link_args.add("/SUBSYSTEM:CONSOLE")
    link_args.add("/ENTRY:trip_start")
    link_args.add("/NODEFAULTLIB")
    link_args.add("/OUT:" + exe.path)
    link_args.add(trip_obj)
    link_args.add(runtime_obj)
    link_args.add_all(import_libs)

    ctx.actions.run(
        executable = ctx.executable.llvm_lld_link,
        arguments = [link_args],
        inputs = depset([trip_obj, runtime_obj] + import_libs),
        tools = depset([ctx.executable.llvm_lld_link] + ctx.files.llvm_dist),
        outputs = [exe],
        mnemonic = "TripWindowsExecutable",
        progress_message = "Linking no-CRT Windows executable %s" % exe.short_path,
    )

    return [DefaultInfo(
        executable = exe,
        files = depset([exe]),
        runfiles = ctx.runfiles(files = [exe]),
    )]

trip_windows_executable = rule(
    implementation = _trip_windows_executable_impl,
    attrs = {
        "import_libs": attr.label_list(mandatory = True),
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
        "llvm_lld_link": attr.label(
            allow_single_file = True,
            cfg = "exec",
            executable = True,
            mandatory = True,
        ),
        "object": attr.label(
            mandatory = True,
        ),
        "runtime_llvm": attr.label(
            allow_single_file = [".ll"],
            mandatory = True,
        ),
    },
    executable = True,
)

def _trip_executable_stdout_test_impl(ctx):
    is_windows = ctx.target_platform_has_constraint(
        ctx.attr._windows_constraint[platform_common.ConstraintValueInfo],
    )
    is_linux = ctx.target_platform_has_constraint(
        ctx.attr._linux_constraint[platform_common.ConstraintValueInfo],
    )
    is_macos = ctx.target_platform_has_constraint(
        ctx.attr._macos_constraint[platform_common.ConstraintValueInfo],
    )
    if not is_windows and not is_linux and not is_macos:
        fail("trip_executable_stdout_test only supports Windows, Linux, and macOS; add target_compatible_with to the target.")

    binary_rootpath = normalize_runfiles_path(ctx.executable.binary.short_path)
    if is_windows:
        binary_path = binary_rootpath.replace("/", "\\")
        ps_script = ctx.actions.declare_file(ctx.label.name + ".ps1")
        launcher = ctx.actions.declare_file(ctx.label.name + ".bat")

        ps_content = "\r\n".join([
            '$ErrorActionPreference = "Stop"',
            "$exe = $args[0]",
            "$expected = " + powershell_dquote_literal(ctx.attr.expected_stdout),
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

        ps_path = normalize_runfiles_path(ps_script.short_path).replace("/", "\\")
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
            "binary=" + sh_single_quote_literal(binary_rootpath),
            "expected=" + sh_single_quote_literal(ctx.attr.expected_stdout),
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

    runfiles = merge_target_runfiles(runfiles, [ctx.attr.binary])
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
        "_macos_constraint": attr.label(
            default = "@platforms//os:macos",
        ),
        "_windows_constraint": attr.label(
            default = "@platforms//os:windows",
        ),
    },
    executable = True,
    test = True,
)
