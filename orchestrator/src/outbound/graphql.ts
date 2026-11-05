import {
  Kind,
  parse,
  print,
  type DocumentNode,
  type OperationDefinitionNode,
  type ValueNode,
} from "graphql/language";
import { deny, hasOnlyKeys, type Deny, type Pins } from "./scope";

/** Keeps a read from being expensive to parse. Far above what a real query uses. */
const MAX_TOKENS = 5000;

/** Allowed mutations and their input fields. commitBody isn't one: it can close an issue. */
const MUTATIONS: Record<string, string[]> = {
  markPullRequestReadyForReview: ["pullRequestId", "clientMutationId"],
  enablePullRequestAutoMerge: ["pullRequestId", "mergeMethod", "expectedHeadOid", "clientMutationId"],
};

type Variables = Record<string, unknown>;

/** A value as GitHub would see it. Throws on a repeated field, which has no single value. */
function valueOf(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case Kind.VARIABLE:
      return Object.hasOwn(variables, node.name.value) ? variables[node.name.value] : undefined;
    case Kind.OBJECT: {
      const object: Record<string, unknown> = {};
      for (const field of node.fields) {
        if (Object.hasOwn(object, field.name.value)) throw new Error("repeated field");
        object[field.name.value] = valueOf(field.value, variables);
      }
      return object;
    }
    case Kind.LIST:
      return node.values.map((value) => valueOf(value, variables));
    case Kind.NULL:
      return null;
    case Kind.INT:
    case Kind.FLOAT:
    case Kind.STRING:
    case Kind.ENUM:
    case Kind.BOOLEAN:
      return node.value;
  }
}

function checkMutation(
  operation: OperationDefinitionNode,
  document: DocumentNode,
  variables: Variables,
  pins: Pins,
): string | null {
  if (document.definitions.length !== 1) return "fragments in a mutation";
  if (operation.directives?.length) return "directive on a mutation";
  if (operation.variableDefinitions?.some((definition) => definition.defaultValue)) {
    return "variable default in a mutation";
  }
  const [field, ...others] = operation.selectionSet.selections;
  if (!field || others.length > 0 || field.kind !== Kind.FIELD) return "one mutation per request";
  if (field.alias) return "alias on a mutation";
  if (field.directives?.length) return "directive on a mutation";

  const allowedFields = Object.hasOwn(MUTATIONS, field.name.value) ? MUTATIONS[field.name.value] : null;
  if (!allowedFields) return "mutation not allowed";

  const [argument, ...moreArguments] = field.arguments ?? [];
  if (!argument || moreArguments.length > 0 || argument.name.value !== "input") return "bad input";
  const input = valueOf(argument.value, variables);
  if (!hasOnlyKeys(input, allowedFields)) return "unexpected input field";
  if (!pins.pr || input.pullRequestId !== pins.pr.nodeId) return "only the run's own PR";
  if (input.mergeMethod !== undefined && input.mergeMethod !== "SQUASH") return "squash only";
  return null;
}

/**
 * GitHub GraphQL: reads, plus one allowed mutation on the run's own PR. The request
 * is parsed, checked and printed again, so GitHub receives what was checked.
 */
export function decideGraphql(body: unknown, pins: Pins): { allow: true; body: string } | Deny {
  if (!hasOnlyKeys(body, ["query", "variables", "operationName"]) || typeof body.query !== "string") {
    return deny("graphql: one operation as a JSON object");
  }
  const variables = body.variables ?? {};
  if (typeof variables !== "object" || Array.isArray(variables)) return deny("graphql: bad variables");

  let document: DocumentNode;
  try {
    document = parse(body.query, { noLocation: true, maxTokens: MAX_TOKENS });
  } catch {
    return deny("graphql: can't parse the document");
  }

  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  const [operation, ...others] = operations;
  if (!operation || others.length > 0) return deny("graphql: one operation per request");
  if (document.definitions.some((d) => d.kind !== Kind.OPERATION_DEFINITION && d.kind !== Kind.FRAGMENT_DEFINITION)) {
    return deny("graphql: unexpected definition");
  }

  if (operation.operation === "mutation") {
    let problem: string | null;
    try {
      problem = checkMutation(operation, document, variables as Variables, pins);
    } catch {
      problem = "bad input";
    }
    if (problem) return deny(`graphql: ${problem}`);
  } else if (operation.operation !== "query") {
    return deny("graphql: reads and allowed mutations only");
  }

  return { allow: true, body: JSON.stringify({ query: print(document), variables }) };
}
