def _codegen_impl(ctx):
    node_toolchain = ctx.toolchains["@rules_nodejs//nodejs:toolchain_type"]
    node_path = node_toolchain.nodeinfo.target_tool_path

    args = ctx.actions.args()
    args.add("--experimental-transform-types")
    args.add(ctx.file.script)
    for arg in ctx.attr.args:
        args.add(ctx.expand_location(arg, ctx.attr.data))

    ctx.actions.run(
        executable = node_toolchain.nodeinfo.node,
        arguments = [args],
        inputs = ctx.files.data + [ctx.file.script, node_toolchain.nodeinfo.node],
        outputs = ctx.outputs.outs,
        mnemonic = "CodeGen",
        progress_message = "Generating code for %s" % ctx.label,
        use_default_shell_env = True,
    )

codegen_rule = rule(
    implementation = _codegen_impl,
    attrs = {
        "args": attr.string_list(),
        "data": attr.label_list(allow_files = True),
        "outs": attr.output_list(mandatory = True),
        "script": attr.label(
            allow_single_file = True,
            mandatory = True,
        ),
    },
    toolchains = ["@rules_nodejs//nodejs:toolchain_type"],
)
