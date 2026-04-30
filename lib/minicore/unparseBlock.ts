import type { Literal } from "./ast.ts";
import type {
  Block,
  BlockCaseAlt,
  BlockInstruction,
  BlockInstructionOp,
  BlockModule,
  BlockParam,
  BlockTerminator,
  BlockValueRef,
} from "./blockAst.ts";
import type { MiniCoreMetadata, MiniType } from "./metadata.ts";

export function unparseBlockModule(module: BlockModule): string {
  return module.symbols
    .filter((symbol) => symbol.kind === "function")
    .map((symbol) => {
      const params = formatParams(symbol.params, module.metadata);
      const header = `function ${symbol.name}(${params}) -> ${formatType(
        symbol.returnType,
        module.metadata,
      )} [${symbol.visibility}] {`;
      const blocks = symbol.blocks
        .map((block) => indent(unparseBlock(block, module), 2))
        .join("\n\n");
      return `${header}\n${blocks}\n}`;
    })
    .join("\n\n");
}

export function unparseBlock(block: Block, module: BlockModule): string {
  const params = formatParams(block.params, module.metadata);
  const label =
    params.length === 0 ? `${block.label}:` : `${block.label}(${params}):`;
  const body = [
    ...block.instructions.map((instruction) =>
      unparseInstruction(instruction, module),
    ),
    unparseTerminator(block.terminator, module),
  ];
  return [label, ...body.map((line) => indent(line, 2))].join("\n");
}

function unparseInstruction(
  instruction: BlockInstruction,
  module: BlockModule,
): string {
  const renderedOp = unparseInstructionOp(instruction.op, module);
  if (!instruction.result) {
    return `${renderedOp} : ${formatType(
      instruction.resultType,
      module.metadata,
    )} !${instruction.effects}`;
  }
  return `${formatParam(instruction.result, module.metadata)} = ${renderedOp} : ${formatType(
    instruction.resultType,
    module.metadata,
  )} !${instruction.effects}`;
}

function unparseInstructionOp(
  op: BlockInstructionOp,
  module: BlockModule,
): string {
  switch (op.kind) {
    case "prim":
    case "call":
    case "construct":
      return `${op.kind} ${op.name}(${op.args
        .map((arg) => unparseValueRef(arg, module))
        .join(", ")})`;
    case "runtimeCall":
      return `runtimeCall ${op.name}(${op.args
        .map((arg) => unparseValueRef(arg, module))
        .join(", ")})`;
    case "move":
      return `move ${unparseValueRef(op.value, module)}`;
  }
}

function unparseTerminator(
  terminator: BlockTerminator,
  module: BlockModule,
): string {
  switch (terminator.kind) {
    case "return":
      return terminator.value
        ? `return ${unparseValueRef(terminator.value, module)}`
        : "return";
    case "jump":
      return `jump ${formatTarget(terminator.target, terminator.args, module)}`;
    case "branch":
      return `branch ${unparseValueRef(
        terminator.condition,
        module,
      )} ${formatTarget(
        terminator.thenTarget,
        terminator.thenArgs,
        module,
      )} ${formatTarget(terminator.elseTarget, terminator.elseArgs, module)}`;
    case "case":
      return [
        `case ${unparseValueRef(terminator.scrutinee, module)} of`,
        ...terminator.alts.map((alt) => indent(unparseCaseAlt(alt, module), 2)),
      ].join("\n");
    case "unreachable":
      return "unreachable";
  }
}

function unparseCaseAlt(alt: BlockCaseAlt, module: BlockModule): string {
  const binders = alt.binders.map((binder) =>
    formatParam(binder, module.metadata),
  );
  const pattern =
    binders.length === 0
      ? alt.constructorName
      : `${alt.constructorName}(${binders.join(", ")})`;
  const targetArgs: BlockValueRef[] = [
    ...alt.binders.map((binder) => ({
      kind: "local" as const,
      id: binder.id,
      name: binder.name,
      type: binder.type,
    })),
    ...alt.args,
  ];
  return `${pattern} -> ${formatTarget(alt.target, targetArgs, module)}`;
}

function formatTarget(
  label: string,
  args: BlockValueRef[],
  module: BlockModule,
): string {
  return `${label}(${args.map((arg) => unparseValueRef(arg, module)).join(", ")})`;
}

function unparseValueRef(value: BlockValueRef, module: BlockModule): string {
  switch (value.kind) {
    case "local":
      return formatLocal(value.id, value.name);
    case "literal":
      return unparseLiteral(value.value);
  }
}

function unparseLiteral(literal: Literal): string {
  switch (literal.kind) {
    case "nat":
      return literal.value.toString();
    case "u8":
      return `${literal.value}u8`;
  }
}

function formatParams(
  params: BlockParam[],
  metadata: MiniCoreMetadata,
): string {
  return params.map((param) => formatParam(param, metadata)).join(", ");
}

function formatParam(param: BlockParam, metadata: MiniCoreMetadata): string {
  return `${formatLocal(param.id, param.name)}: ${formatType(param.type, metadata)}`;
}

function formatLocal(id: number, name?: string): string {
  return name ? `%${id}/${name}` : `%${id}`;
}

function formatType(type: MiniType, metadata: MiniCoreMetadata): string {
  switch (type.kind) {
    case "nat":
    case "u8":
    case "bool":
    case "unit":
    case "unknown":
      return type.kind;
    case "var":
      return type.name;
    case "data": {
      const name = metadata.dataTypes.get(type.id)?.name ?? `data#${type.id}`;
      return type.args.length === 0
        ? name
        : `${name}<${type.args.map((arg) => formatType(arg, metadata)).join(", ")}>`;
    }
    case "fn":
      return `(${[...type.params, type.result]
        .map((part) => formatType(part, metadata))
        .join(" -> ")})`;
    case "forall":
      return `forall ${type.params.join(" ")}. ${formatType(
        type.body,
        metadata,
      )}`;
  }
}

function indent(input: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return input
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
