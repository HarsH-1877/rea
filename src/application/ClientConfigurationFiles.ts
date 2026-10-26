import { err, ok, type Result } from "../domain/result.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import { readRegularFileText } from "./RegularFileRead.js";
import {
  effectiveClientServer,
  parseClientConfiguration,
  type ClientConfigurationDocument,
  type ClientRegistrationDialect,
} from "./ClientConfigurationDocument.js";
import type { SetupClient } from "./SupportedClients.js";
import { clientRegistrationEnvironment } from "./ClientRegistrationEnvironment.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import { mergeEnvironmentOverrides } from "../process/snapshotEnvironment.js";
import { PRODUCT_IDENTITY } from "../identity.js";

export type ClientRegistrationScope = "user" | "project";

/** A parsed layer retains its path so rereading the write target replaces only that layer. */
export interface ClientConfigurationSource extends ClientConfigurationDocument {
  readonly sourcePath: string;
}

const invalidEnvironment = (
  path: string,
  error: ConfigurationError,
  scope?: ClientRegistrationScope,
): ClientConfigurationFileError => ({
  kind: "malformed",
  path,
  ...(scope === undefined ? {} : { scope }),
  detail:
    scope === "project"
      ? `Configuration ${path} has an invalid REA server environment: ${error.settings.map(({ setting, constraint }) => `${setting}: ${constraint}`).join("; ")}. Repair ${path} and rerun rea doctor; REA setup does not modify project-scoped configuration.`
      : `Configuration ${path} has an invalid REA server environment: ${error.settings.map(({ setting, constraint }) => `${setting}: ${constraint}`).join("; ")}. Repair it before rerunning setup.`,
});

/** A named source failure that setup can explain without losing the bad path. */
export interface ClientConfigurationFileError {
  readonly kind: "unreadable" | "malformed";
  readonly path: string;
  readonly scope?: ClientRegistrationScope;
  readonly detail: string;
  readonly cleanupFailure?: RegularFileCleanupFailure;
}

/** Preserve named read failures and distinguish a missing source from an empty file. */
export const readConfigurationText = async (
  path: string,
  resources?: ArtifactResourceScope,
): Promise<Result<string | undefined, ClientConfigurationFileError>> => {
  try {
    return ok(
      await readRegularFileText(
        path,
        resources === undefined ? {} : { resources },
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return ok(undefined);
    return err({
      kind: "unreadable",
      path,
      detail: `Configuration ${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      ...(cause instanceof RegularFileCleanupFailure
        ? { cleanupFailure: cause }
        : {}),
    });
  }
};

/** Read and parse one configuration at its source boundary. */
export const readConfigurationFile = async (
  path: string,
  format: SetupClient["format"],
  resources?: ArtifactResourceScope,
): Promise<
  Result<ClientConfigurationDocument | undefined, ClientConfigurationFileError>
> => {
  const source = await readConfigurationText(path, resources);
  if (!source.ok) return source;
  const content = source.value;
  if (content === undefined) return ok(undefined);
  try {
    return ok(parseClientConfiguration(content, format));
  } catch (cause: unknown) {
    return err({
      kind: "malformed",
      path,
      detail: `Configuration ${path} is malformed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
};

/** Read each layer; setup may validate its writable layer with proposed overrides. */
export const readClientConfigurationFiles = async (
  client: SetupClient,
  resources?: ArtifactResourceScope,
  platform: NodeJS.Platform = process.platform,
  writeOverrides?: Readonly<Record<string, string>>,
): Promise<
  Result<readonly ClientConfigurationSource[], ClientConfigurationFileError>
> => {
  const documents: ClientConfigurationSource[] = [];
  for (const path of client.configPaths ?? [client.configPath]) {
    const document = await readConfigurationFile(
      path,
      client.format,
      resources,
    );
    if (!document.ok) return document;
    if (document.value !== undefined) {
      const environment = clientRegistrationEnvironment(
        document.value,
        path === client.configPath ? writeOverrides : undefined,
        "fragment",
        platform,
      );
      if (!environment.ok)
        return err(invalidEnvironment(path, environment.error));
      documents.push({ ...document.value, sourcePath: path });
    }
  }
  const environment = clientRegistrationEnvironment(
    effectiveClientConfiguration(documents, undefined, platform),
    writeOverrides,
    "effective",
    platform,
  );
  if (!environment.ok)
    return err(invalidEnvironment(client.configPath, environment.error));
  return ok(documents);
};

/** OpenCode merges server objects in file order, replacing arrays and scalar values. */
const mergeConfigurationValue = (previous: unknown, next: unknown): unknown => {
  if (!isObject(previous) || !isObject(next)) return next;
  return Object.fromEntries(
    [...new Set([...Object.keys(previous), ...Object.keys(next)])].map(
      (key) => [
        key,
        Object.hasOwn(next, key)
          ? mergeConfigurationValue(previous[key], next[key])
          : previous[key],
      ],
    ),
  );
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Native OpenCode dialect applies across all selected configuration layers. */
export const clientWriteDialect = (
  dialect: ClientRegistrationDialect,
  sources: readonly ClientConfigurationDocument[],
): ClientRegistrationDialect =>
  dialect === "opencode" &&
  sources.some(({ dialect }) => dialect === "opencode_v2")
    ? "opencode_v2"
    : dialect;

/** Interpret the write fragment using the effective client dialect, preserving peers. */
export const clientConfigurationForWrite = (
  parsed: ClientConfigurationDocument,
  sources: readonly ClientConfigurationDocument[],
): ClientConfigurationDocument => {
  if (
    parsed.dialect !== "opencode" ||
    clientWriteDialect(parsed.dialect, sources) !== "opencode_v2"
  )
    return parsed;
  if (Object.hasOwn(parsed.servers, "servers"))
    throw new TypeError(
      "A legacy OpenCode server named servers conflicts with the effective native server table; repair this ambiguity before setup",
    );
  return {
    ...parsed,
    dialect: "opencode_v2",
    serversPath: ["mcp", "servers"],
    servers: {},
    legacyServers: parsed.servers,
  };
};

/** Project a client's effective user registration without modifying its source files. */
export const effectiveClientConfiguration = (
  sources: readonly ClientConfigurationSource[],
  target?: {
    readonly client: Pick<SetupClient, "configPath" | "configPaths">;
    readonly document: ClientConfigurationDocument | undefined;
  },
  platform: NodeJS.Platform = process.platform,
): ClientConfigurationDocument | undefined => {
  const documents =
    target === undefined
      ? sources
      : (target.client.configPaths ?? [target.client.configPath]).flatMap(
          (path) => {
            const document =
              path === target.client.configPath
                ? target.document
                : sources.find(({ sourcePath }) => sourcePath === path);
            return document === undefined ? [] : [document];
          },
        );
  const last = documents.at(-1);
  if (last === undefined) return undefined;
  if (documents.length === 1) return last;
  const servers: Record<string, unknown> = Object.create(null);
  for (const document of documents) {
    const names = new Set([
      ...Object.keys(document.legacyServers),
      ...Object.keys(document.servers),
    ]);
    for (const name of names) {
      const previous = servers[name];
      const next = effectiveClientServer(document, name);
      const merged = mergeConfigurationValue(previous, next);
      const key = document.environmentKey;
      if (
        name === PRODUCT_IDENTITY.mcpServerKey &&
        isObject(merged) &&
        isObject(merged[key])
      ) {
        const before =
          isObject(previous) && isObject(previous[key]) ? previous[key] : {};
        const after = isObject(next) && isObject(next[key]) ? next[key] : {};
        servers[name] = {
          ...merged,
          [key]: mergeEnvironmentOverrides(before, after, platform),
        };
      } else servers[name] = merged;
    }
  }
  return {
    ...last,
    dialect: clientWriteDialect(last.dialect, documents),
    servers,
    legacyServers: {},
  };
};

const isPiPartialServerOverride = (
  entry: unknown,
): entry is Record<string, unknown> =>
  isObject(entry) &&
  !Object.hasOwn(entry, "command") &&
  !Object.hasOwn(entry, "url") &&
  !Object.hasOwn(entry, "type");

export interface EffectiveClientRegistrationConfiguration {
  readonly document: ClientConfigurationDocument | undefined;
  readonly configPath: string;
  readonly scope?: ClientRegistrationScope;
  readonly launcherScope?: ClientRegistrationScope;
  readonly launcherConfigPath?: string;
}

/** Read the configuration the client will load across project and user scopes. */
export const readEffectiveClientRegistrationConfiguration = async (
  client: SetupClient,
  resources?: ArtifactResourceScope,
  platform: NodeJS.Platform = process.platform,
  targetScope: "user" | "all" = "all",
): Promise<
  Result<EffectiveClientRegistrationConfiguration, ClientConfigurationFileError>
> => {
  const nativeSources = await readClientConfigurationFiles(
    client,
    resources,
    platform,
  );
  if (!nativeSources.ok)
    return err({
      ...nativeSources.error,
      scope: nativeSources.error.scope ?? "user",
    });
  const nativeDocument = effectiveClientConfiguration(
    nativeSources.value,
    undefined,
    platform,
  );

  if (
    targetScope !== "user" &&
    client.format === "pi" &&
    client.projectConfigPaths !== undefined &&
    client.projectConfigPaths.length > 0
  ) {
    const projectPath = client.projectConfigPaths[0];
    if (projectPath !== undefined) {
      const projectFile = await readConfigurationFile(
        projectPath,
        client.format,
        resources,
      );
      if (!projectFile.ok)
        return err({ ...projectFile.error, scope: "project" });
      if (projectFile.value !== undefined) {
        const fragmentEnv = clientRegistrationEnvironment(
          projectFile.value,
          {},
          "fragment",
          platform,
        );
        if (!fragmentEnv.ok)
          return err(
            invalidEnvironment(projectPath, fragmentEnv.error, "project"),
          );

        const rawProjectRea = effectiveClientServer(
          projectFile.value,
          PRODUCT_IDENTITY.mcpServerKey,
        );
        if (rawProjectRea !== undefined) {
          const rawUserRea =
            nativeDocument === undefined
              ? undefined
              : effectiveClientServer(
                  nativeDocument,
                  PRODUCT_IDENTITY.mcpServerKey,
                );
          let effectiveRea = rawProjectRea;
          let isProjectLauncher = true;
          let launcherConfigPath = projectPath;
          if (
            isPiPartialServerOverride(rawProjectRea) &&
            isObject(rawUserRea)
          ) {
            const merged: Record<string, unknown> = { ...rawUserRea };
            if (Object.hasOwn(rawProjectRea, "enabled"))
              merged.enabled = rawProjectRea.enabled;
            if (Object.hasOwn(rawProjectRea, "exposure"))
              merged.exposure = rawProjectRea.exposure;
            if (Object.hasOwn(rawProjectRea, "toolExposure"))
              merged.toolExposure = rawProjectRea.toolExposure;
            effectiveRea = merged;
            isProjectLauncher = false;
            launcherConfigPath = client.configPath;
          }
          const effectiveDoc: ClientConfigurationDocument = {
            ...projectFile.value,
            servers: {
              ...projectFile.value.servers,
              [PRODUCT_IDENTITY.mcpServerKey]: effectiveRea,
            },
          };
          const effectiveEnv = clientRegistrationEnvironment(
            effectiveDoc,
            {},
            "effective",
            platform,
          );
          if (!effectiveEnv.ok)
            return err(
              invalidEnvironment(projectPath, effectiveEnv.error, "project"),
            );
          return ok({
            document: effectiveDoc,
            configPath: projectPath,
            scope: "project",
            launcherScope: isProjectLauncher ? "project" : "user",
            launcherConfigPath,
          });
        }
      }
    }
  }

  if (
    targetScope !== "user" &&
    client.format === "opencode" &&
    client.projectConfigPaths !== undefined &&
    client.projectConfigPaths.length > 0
  ) {
    const projectSources: ClientConfigurationSource[] = [];
    for (const path of client.projectConfigPaths) {
      const document = await readConfigurationFile(
        path,
        client.format,
        resources,
      );
      if (!document.ok) return err({ ...document.error, scope: "project" });
      if (document.value !== undefined) {
        const env = clientRegistrationEnvironment(
          document.value,
          {},
          "fragment",
          platform,
        );
        if (!env.ok) return err(invalidEnvironment(path, env.error, "project"));
        projectSources.push({ ...document.value, sourcePath: path });
      }
    }

    const allSources = [...nativeSources.value, ...projectSources];
    const winningProjectDoc = [...projectSources]
      .reverse()
      .find(
        (doc) =>
          effectiveClientServer(doc, PRODUCT_IDENTITY.mcpServerKey) !==
          undefined,
      );
    if (winningProjectDoc !== undefined) {
      const effectiveDoc = effectiveClientConfiguration(
        allSources,
        undefined,
        platform,
      );
      if (effectiveDoc !== undefined) {
        const effectiveEnv = clientRegistrationEnvironment(
          effectiveDoc,
          {},
          "effective",
          platform,
        );
        if (!effectiveEnv.ok)
          return err(
            invalidEnvironment(
              winningProjectDoc.sourcePath,
              effectiveEnv.error,
              "project",
            ),
          );
        const launcherDoc = [...allSources].reverse().find((doc) => {
          const s = effectiveClientServer(doc, PRODUCT_IDENTITY.mcpServerKey);
          return isObject(s) && Object.hasOwn(s, "command");
        });
        const isProjectLauncher =
          launcherDoc !== undefined &&
          projectSources.some(
            (proj) => proj.sourcePath === launcherDoc.sourcePath,
          );
        return ok({
          document: effectiveDoc,
          configPath: winningProjectDoc.sourcePath,
          scope: "project",
          launcherScope: isProjectLauncher ? "project" : "user",
          launcherConfigPath:
            launcherDoc?.sourcePath ?? winningProjectDoc.sourcePath,
        });
      }
    }
  }

  const fallbackPath =
    client.format === "zcode" ? client.zcodeFallbackPath : undefined;
  if (
    fallbackPath === undefined ||
    (nativeDocument !== undefined &&
      Object.keys(nativeDocument.servers).length > 0)
  )
    return ok({
      document: nativeDocument,
      configPath: client.configPath,
      scope: "user",
      launcherScope: "user",
      launcherConfigPath: client.configPath,
    });

  const fallbackClient: SetupClient = {
    ...client,
    configPath: fallbackPath,
    configPaths: [fallbackPath],
    format: "zcode_fallback",
  };
  const fallbackSources = await readClientConfigurationFiles(
    fallbackClient,
    resources,
    platform,
  );
  if (!fallbackSources.ok)
    return err({
      ...fallbackSources.error,
      scope: fallbackSources.error.scope ?? "user",
    });
  const fallbackDocument = effectiveClientConfiguration(
    fallbackSources.value,
    undefined,
    platform,
  );
  return ok(
    fallbackDocument === undefined
      ? {
          document: nativeDocument,
          configPath: client.configPath,
          scope: "user",
          launcherScope: "user",
          launcherConfigPath: client.configPath,
        }
      : {
          document: fallbackDocument,
          configPath: fallbackPath,
          scope: "user",
          launcherScope: "user",
          launcherConfigPath: fallbackPath,
        },
  );
};
