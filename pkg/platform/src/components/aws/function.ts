import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver from "archiver";
import type { Loader, BuildOptions } from "esbuild";
import {
  Output,
  ComponentResourceOptions,
  asset,
  output,
  all,
  interpolate,
  jsonStringify,
} from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { build } from "../../runtime/node.js";
import { FunctionCodeUpdater } from "./providers/function-code-updater.js";
import { bootstrap } from "./helpers/bootstrap.js";
import { LogGroup } from "./providers/log-group.js";
import { Duration, toSeconds } from "../duration.js";
import { Size, toMBs } from "../size.js";
import { Component, Prettify, Transform, transform } from "../component.js";
import { Link } from "../link.js";
import { VisibleError } from "../error.js";
import { Warp } from "../warp.js";
import type { Input } from "../input.js";

const RETENTION = {
  "1 day": 1,
  "3 days": 3,
  "5 days": 5,
  "1 week": 7,
  "2 weeks": 14,
  "1 month": 30,
  "2 months": 60,
  "3 months": 90,
  "4 months": 120,
  "5 months": 150,
  "6 months": 180,
  "1 year": 365,
  "13 months": 400,
  "18 months": 545,
  "2 years": 731,
  "3 years": 1096,
  "5 years": 1827,
  "6 years": 2192,
  "7 years": 2557,
  "8 years": 2922,
  "9 years": 3288,
  "10 years": 3653,
  forever: 0,
};

export type FunctionPermissionArgs = {
  /**
   * IAM actions to allow to perform on the resources.
   */
  actions: string[];
  /**
   * The Amazon Resource Name (ARN) of the resources to allow actions on.
   */
  resources: Input<string>[];
};

interface FunctionUrlCorsArgs
  extends Omit<
    aws.types.input.lambda.FunctionUrlCors,
    "allowMethods" | "maxAge"
  > {
  /**
   * The HTTP methods that are allowed when calling the function URL. For example: `["GET", "POST", "DELETE"]`, or the wildcard character (`["*"]`).
   */
  allowMethods?: Input<
    Input<
      "*" | "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT"
    >[]
  >;
  /**
   * The maximum amount of time, in seconds, that web browsers can cache results of a preflight request. By default, this is set to `0`, which means that the browser doesn't cache results. The maximum value is `86400`.
   */
  maxAge?: Input<Duration>;
}

export interface FunctionArgs {
  /**
   * A description for the function.
   * @default No description
   * @example
   * ```js
   * {
   *   description: "Handler function for my nightly cron job."
   * }
   * ```
   */
  description?: Input<string>;
  /**
   * The runtime environment for the function.
   * @default `nodejs18.x`
   * @example
   * ```js
   * {
   *   runtime: "nodejs20.x"
   * }
   * ```
   */
  runtime?: Input<"nodejs18.x" | "nodejs20.x" | "provided.al2023">;
  /**
   * Path to the source code directory for the function.
   * Use `bundle` only when the function code is ready to be deployed to Lambda.
   * Typically, omit `bundle`. If omitted, the handler file is bundled with esbuild, using its output directory as the bundle folder.
   * @default Path to the esbuild output directory
   * @example
   * ```js
   * {
   *   bundle: "packages/functions/src",
   *   handler: "index.handler"
   * }
   * ```
   */
  bundle?: Input<string>;
  /**
   * Path to the handler for the function.
   * @example
   * When `bundle` is specified, the handler is relative to the bundle folder.
   * ```js
   * {
   *   bundle: "packages/functions/src",
   *   handler: "index.handler"
   * }
   * ```
   * @example
   * When `bundle` is not specified, the handler is relative to the root of your SST application.
   * ```js
   * {
   *   handler: "packages/functions/src/index.handler"
   * }
   * ```
   */
  handler: Input<string>;
  /**
   * The amount of time that Lambda allows a function to run before stopping it.
   * @default `20 seconds`
   * @example
   * ```js
   * {
   *   timeout: "900 seconds"
   * }
   * ```
   */
  timeout?: Input<Duration>;
  /**
   * The amount of memory allocated for the function.
   * @default `1024 MB`
   * @example
   * ```js
   * {
   *   memory: "10240 MB"
   * }
   * ```
   */
  memory?: Input<Size>;
  /**
   * Key-value pairs that Lambda makes available for the function at runtime.
   * @default No environment variables
   * @example
   * ```js
   * {
   *   environment: {
   *     DEBUG: "true"
   *   }
   * }
   * ```
   */
  environment?: Input<Record<string, Input<string>>>;
  /**
   * Permissions and the resources that the function needs to access.
   * The permissions are use to create the function's IAM role.
   * @default No permissions
   * @example
   * Allow function to read and write to the S3 bucket `my-bucket`.
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["s3:GetObject", "s3:PutObject"],
   *       resources: ["arn:aws:s3:::my-bucket/*"],
   *     },
   *   ]
   * }
   * ```
   *
   * Allow function to perform all actions on the S3 bucket `my-bucket`.
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["s3:*"],
   *       resources: ["arn:aws:s3:::my-bucket/*"],
   *     },
   *   ]
   * }
   * ```
   *
   * Granting function permissions to access all resources.
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["*"],
   *       resources: ["*"],
   *     },
   *   ]
   * }
   * ```
   */
  permissions?: Input<Prettify<FunctionPermissionArgs>[]>;
  /**
   * Link resources to the function.
   * This will grant the function permissions to access the linked resources at runtime.
   *
   * @example
   * ```js
   * {
   *   link: [myBucket, stripeKey],
   * }
   * ```
   */
  link?: Input<any[]>;
  /**
   * Whether to enable streaming for the function.
   * @default `false`
   * @example
   * ```js
   * {
   *   streaming: true
   * }
   * ```
   */
  streaming?: Input<boolean>;
  /**
   * @internal
   */
  injections?: Input<string[]>;
  /**
   * Configure function logging
   * @default Logs retained indefinitely
   * @example
   * ```js
   * {
   *   logging: {
   *     retention: "1 week"
   *   }
   * }
   * ```
   */
  logging?: Input<{
    /**
     * The duration function logs are kept in CloudWatch Logs.
     * @default `forever`
     */
    retention?: Input<keyof typeof RETENTION>;
  }>;
  /**
   * The system architectures for the function.
   * @default `x86_64`
   * @example
   * ```js
   * {
   *   architecture: "arm64"
   * }
   * ```
   */
  architecture?: Input<"x86_64" | "arm64">;
  /**
   * Enable function URLs, a dedicated endpoint for your Lambda function.
   * @default Disabled `false`
   * @example
   * ```js
   * {
   *   url: true
   * }
   * ```
   *
   * ```js
   * {
   *   url: {
   *     authorization: "iam",
   *     cors: {
   *       allowedOrigins: ['https://example.com'],
   *     }
   *   }
   * }
   * ```
   */
  url?: Input<
    | boolean
    | {
        /**
         * The authorization for the function URL
         * @default `none`
         * @example
         * ```js
         * {
         *   url: {
         *     authorization: "iam",
         *   },
         * }
         * ```
         */
        authorization?: Input<"none" | "iam">;
        /**
         * CORS support for the function URL
         * @default `true`
         * @example
         * ```js
         * {
         *   url: {
         *     cors: true,
         *   },
         * }
         * ```
         *
         * ```js
         * {
         *   url: {
         *     cors: {
         *       allowedMethods: ["GET", "POST"],
         *       allowedOrigins: ['https://example.com'],
         *     },
         *   },
         * }
         * ```
         */
        cors?: Input<boolean | Prettify<FunctionUrlCorsArgs>>;
      }
  >;
  /**
   * Used to configure nodejs function properties
   */
  nodejs?: Input<{
    // TODO exclude
    /**
     * Configure additional esbuild loaders for other file extensions
     *
     * @example
     * ```js
     * nodejs: {
     *   loader: {
     *    ".png": "file"
     *   }
     * }
     * ```
     */
    loader?: Input<Record<string, Loader>>;
    /**
     * Packages that will be excluded from the bundle and installed into node_modules instead. Useful for dependencies that cannot be bundled, like those with binary dependencies.
     *
     * @example
     * ```js
     * nodejs: {
     *   install: ["pg"]
     * }
     * ```
     */
    install?: Input<string[]>;
    /**
     * Use this to insert an arbitrary string at the beginning of generated JavaScript and CSS files.
     *
     * @example
     * ```js
     * nodejs: {
     *   banner: "console.log('Function starting')"
     * }
     * ```
     */
    banner?: Input<string>;
    /**
     * This allows you to customize esbuild config.
     */
    esbuild?: Input<BuildOptions>;
    /**
     * Enable or disable minification
     *
     * @default `true`
     *
     * @example
     * ```js
     * nodejs: {
     *   minify: false
     * }
     * ```
     */
    minify?: Input<boolean>;
    /**
     * Configure format
     *
     * @default `esm`
     *
     * @example
     * ```js
     * nodejs: {
     *   format: "cjs"
     * }
     * ```
     */
    format?: Input<"cjs" | "esm">;
    /**
     * Configure if sourcemaps are generated when the function is bundled for production. Since they increase payload size and potentially cold starts they are not generated by default. They are always generated during local development mode.
     *
     * @default `false`
     *
     * @example
     * ```js
     * nodejs: {
     *   sourcemap: true
     * }
     * ```
     */
    sourcemap?: Input<boolean>;
    /**
     * If enabled, modules that are dynamically imported will be bundled as their own files with common dependencies placed in shared chunks. This can help drastically reduce cold starts as your function grows in size.
     *
     * @default `false`
     *
     * @example
     * ```js
     * nodejs: {
     *   splitting: true
     * }
     * ```
     */
    splitting?: Input<boolean>;
  }>;
  /**
   * Used to configure additional files to copy into the function bundle
   *
   * @example
   * ```js
   * {
   *   copyFiles: [{ from: "src/index.js" }]
   * }
   *```
   */
  copyFiles?: Input<
    {
      /**
       * Source path relative to sst.config.ts
       */
      from: Input<string>;
      /**
       * Destination path relative to function root in bundle
       */
      to?: Input<string>;
    }[]
  >;
  /**
   * [Transform](/docs/transform/) how this component is created.
   */
  transform?: {
    function?: Transform<aws.lambda.FunctionArgs>;
  };
}

/**
 * The `Function` component is a higher level component that makes it easy to create an AWS Lambda Function.
 *
 * @example
 *
 * #### Using the minimal config
 * ```ts
 * new sst.aws.Function("MyFunction", {
 *   handler: "src/lambda.handler",
 * });
 * ```
 */
export class Function
  extends Component
  implements Link.Linkable, Link.AWS.Linkable
{
  private function: Output<aws.lambda.Function>;
  private role: Output<aws.iam.Role>;
  private logGroup: LogGroup;
  private fnUrl: Output<aws.lambda.FunctionUrl | undefined>;
  private missingSourcemap?: boolean;

  constructor(
    name: string,
    args: FunctionArgs,
    opts?: ComponentResourceOptions,
  ) {
    super("sst:aws:Function", name, args, opts);

    const parent = this;
    const region = normalizeRegion();
    const injections = normalizeInjections();
    const runtime = normalizeRuntime();
    const timeout = normalizeTimeout();
    const memory = normalizeMemory();
    const architectures = normalizeArchitectures();
    const environment = normalizeEnvironment();
    const streaming = normalizeStreaming();
    const logging = normalizeLogging();
    const url = normalizeUrl();
    const copyFiles = normalizeCopyFiles();

    const linkData = buildLinkData();
    const linkPermissions = buildLinkPermissions();
    const { bundle, handler: handler0 } = buildHandler();
    const { handler, wrapper } = buildHandlerWrapper();
    const role = createRole();
    const zipPath = zipBundleFolder();
    const bundleHash = calculateHash();
    const file = createBucketObject();
    const fnRaw = createFunction();
    const fn = updateFunctionCode();

    const logGroup = createLogGroup();
    const fnUrl = createUrl();

    const links = output(linkData).apply((input) =>
      input.map((item) => item.name),
    );

    if ($dev) {
      Warp.register({
        functionID: name,
        links,
        handler: args.handler,
        bundle: args.bundle,
        runtime: output(args.runtime).apply((v) => v ?? "nodejs18.x"),
        properties: all([args.nodejs]).apply(([nodejs]) => nodejs || {}),
      });
    }

    all([args.handler, args.bundle, links]).apply(
      ([handler, bundle, rawLinks]) => {
        if (!rawLinks.length) return;
        Link.Receiver.register(bundle || handler, links);
      },
    );

    this.registerOutputs({
      _metadata: {
        handler: args.handler,
      },
    });

    this.function = fn;
    this.role = role;
    this.logGroup = logGroup;
    this.fnUrl = fnUrl;

    function normalizeRegion() {
      return all([
        $app.providers?.aws?.region!,
        (opts?.provider as aws.Provider)?.region,
      ]).apply(([appRegion, region]) => region ?? appRegion);
    }

    function normalizeInjections() {
      return output(args.injections).apply((injections) => injections ?? []);
    }

    function normalizeRuntime() {
      if ($dev) {
        return "provided.al2023";
      }
      return output(args.runtime).apply((v) => v ?? "nodejs18.x");
    }

    function normalizeTimeout() {
      return output(args.timeout).apply((timeout) => timeout ?? "20 seconds");
    }

    function normalizeMemory() {
      return output(args.memory).apply((memory) => memory ?? "1024 MB");
    }

    function normalizeArchitectures() {
      return output(args.architecture).apply((arc) =>
        arc === "arm64" ? ["arm64"] : ["x86_64"],
      );
    }

    function normalizeEnvironment() {
      return output(args.environment).apply((environment) => {
        const result = environment ?? {};
        if ($dev) {
          result.SST_FUNCTION_ID = name;
          result.SST_APP = $app.name;
          result.SST_STAGE = $app.stage;
        }
        return result;
      });
    }

    function normalizeStreaming() {
      return output(args.streaming).apply((streaming) => streaming ?? false);
    }

    function normalizeLogging() {
      return output(args.logging).apply((logging) => ({
        ...logging,
        retention: logging?.retention ?? "forever",
      }));
    }

    function normalizeUrl() {
      return output(args.url).apply((url) => {
        if (url === false || url === undefined) return;
        if (url === true) {
          url = {};
        }

        // normalize authorization
        const defaultAuthorization = "none" as const;
        const authorization = url.authorization ?? defaultAuthorization;

        // normalize cors
        const defaultCors: aws.types.input.lambda.FunctionUrlCors = {
          allowHeaders: ["*"],
          allowMethods: ["*"],
          allowOrigins: ["*"],
        };
        const cors =
          url.cors === false
            ? {}
            : url.cors === true || url.cors === undefined
              ? defaultCors
              : {
                  ...defaultCors,
                  ...url.cors,
                  maxAge: url.cors.maxAge && toSeconds(url.cors.maxAge),
                };

        return { authorization, cors };
      });
    }

    function normalizeCopyFiles() {
      return output(args.copyFiles ?? []).apply((copyFiles) =>
        Promise.all(
          copyFiles.map(async (entry) => {
            const from = path.join($cli.paths.root, entry.from);
            const to = entry.to || entry.from;
            if (path.isAbsolute(to))
              throw new VisibleError(
                `Copy destination path "${to}" must be relative`,
              );

            const stats = await fs.promises.stat(from);
            const isDir = stats.isDirectory();

            return { from, to, isDir };
          }),
        ),
      );
    }

    function calculateHash() {
      return zipPath.apply(async (zipPath) => {
        const hash = crypto.createHash("sha256");
        hash.update(await fs.promises.readFile(zipPath));
        return hash.digest("hex");
      });
    }

    function buildLinkData() {
      if (!args.link) return output([]);
      return output(args.link).apply((links) => {
        const linkData = Link.build(links);
        return linkData;
      });
    }

    function buildLinkPermissions() {
      return output(args.link ?? []).apply((links) =>
        links.flatMap((l) => {
          if (!Link.AWS.isLinkable(l)) return [];
          return l.getSSTAWSPermissions();
        }),
      );
    }

    function buildHandler() {
      if ($dev) {
        return {
          handler: "bootstrap",
          bundle: path.join($cli.paths.platform, "dist", "bridge"),
        };
      }

      if (args.bundle) {
        return {
          bundle: output(args.bundle),
          handler: output(args.handler),
        };
      }

      const buildResult = all([args, linkData]).apply(
        async ([args, linkData]) => {
          const result = await build(name, {
            ...args,
            links: linkData,
          });
          if (result.type === "error")
            throw new Error(result.errors.join("\n"));
          return result;
        },
      );
      return {
        handler: buildResult.handler,
        bundle: buildResult.out,
      };
    }

    function buildHandlerWrapper() {
      const ret = all([
        bundle,
        handler0,
        linkData,
        streaming,
        injections,
      ]).apply(async ([bundle, handler, linkData, streaming, injections]) => {
        const hasUserInjections = injections.length > 0;
        // already injected via esbuild when bundle is undefined
        const hasLinkInjections = args.bundle && linkData.length > 0;

        if (!hasUserInjections && !hasLinkInjections) return { handler };

        const linkInjection = hasLinkInjections
          ? linkData
              .map((item) => [
                `process.env.SST_RESOURCE_${item.name} = ${JSON.stringify(
                  JSON.stringify(item.value),
                )};\n`,
              ])
              .join("")
          : "";

        const parsed = path.posix.parse(handler);
        const handlerDir = parsed.dir;
        const oldHandlerFileName = parsed.name;
        const oldHandlerFunction = parsed.ext.replace(/^\./, "");
        const newHandlerFileName = "server-index";
        const newHandlerFunction = "handler";

        // Validate handler file exists
        const newHandlerFileExt = [".js", ".mjs", ".cjs"].find((ext) =>
          fs.existsSync(
            path.join(bundle, handlerDir, oldHandlerFileName + ext),
          ),
        );
        if (!newHandlerFileExt)
          throw new VisibleError(
            `Could not find file for handler "${handler}"`,
          );

        return {
          handler: path.posix.join(
            handlerDir,
            `${newHandlerFileName}.${newHandlerFunction}`,
          ),
          wrapper: {
            dir: handlerDir,
            name: `${newHandlerFileName}.mjs`,
            content: streaming
              ? [
                  linkInjection,
                  `export const ${newHandlerFunction} = awslambda.streamifyResponse(async (event, context) => {`,
                  ...injections,
                  `  const { ${oldHandlerFunction}: rawHandler} = await import("./${oldHandlerFileName}${newHandlerFileExt}");`,
                  `  return rawHandler(event, context);`,
                  `});`,
                ].join("\n")
              : [
                  linkInjection,
                  `export const ${newHandlerFunction} = async (event, context) => {`,
                  ...injections,
                  `  const { ${oldHandlerFunction}: rawHandler} = await import("./${oldHandlerFileName}${newHandlerFileExt}");`,
                  `  return rawHandler(event, context);`,
                  `};`,
                ].join("\n"),
          },
        };
      });
      return {
        handler: ret.handler,
        wrapper: ret.wrapper,
      };
    }

    function createRole() {
      return all([args.permissions || [], linkPermissions]).apply(
        ([argsPermissions, linkPermissions]) => {
          return new aws.iam.Role(
            `${name}Role`,
            {
              assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
                Service: "lambda.amazonaws.com",
              }),
              inlinePolicies: [
                {
                  name: "inline",
                  policy: jsonStringify({
                    Statement: [
                      ...argsPermissions,
                      ...linkPermissions,
                      ...($dev
                        ? [
                            {
                              actions: ["iot:*"],
                              resources: ["*"],
                            },
                          ]
                        : []),
                    ].map((p) => ({
                      Effect: "Allow",
                      Action: p.actions,
                      Resource: p.resources,
                    })),
                  }),
                },
              ],
              managedPolicyArns: [
                "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
              ],
            },
            { parent },
          );
        },
      );
    }

    function zipBundleFolder() {
      // Note: cannot point the bundle to the `.open-next/server-function`
      //       b/c the folder contains node_modules. And pnpm node_modules
      //       contains symlinks. Pulumi cannot zip symlinks correctly.
      //       We will zip the folder ourselves.
      return all([bundle, wrapper, copyFiles]).apply(
        async ([bundle, wrapper, copyFiles]) => {
          const zipPath = path.resolve(
            $cli.paths.work,
            "artifacts",
            name,
            "code.zip",
          );
          await fs.promises.mkdir(path.dirname(zipPath), {
            recursive: true,
          });

          await new Promise(async (resolve, reject) => {
            const ws = fs.createWriteStream(zipPath);
            const archive = archiver("zip", {
              // Ensure deterministic zip file hashes
              // https://github.com/archiverjs/node-archiver/issues/397#issuecomment-554327338
              statConcurrency: 1,
            });
            archive.on("warning", reject);
            archive.on("error", reject);
            // archive has been finalized and the output file descriptor has closed, resolve promise
            // this has to be done before calling `finalize` since the events may fire immediately after.
            // see https://www.npmjs.com/package/archiver
            ws.once("close", () => {
              resolve(zipPath);
            });
            archive.pipe(ws);

            // set the date to 0 so that the zip file is deterministic
            archive.glob(
              "**",
              { cwd: bundle, dot: true },
              { date: new Date(0), mode: 0o777 },
            );

            // Add handler wrapper into the zip
            if (wrapper) {
              archive.append(wrapper.content, {
                name: wrapper.name,
                date: new Date(0),
              });
            }

            // Add copyFiles into the zip
            copyFiles.forEach(async (entry) => {
              // TODO
              //if ($app. mode === "deploy")
              entry.isDir
                ? archive.directory(entry.from, entry.to, { date: new Date(0) })
                : archive.file(entry.from, {
                    name: entry.to,
                    date: new Date(0),
                  });
              //if (mode === "start") {
              //  try {
              //    const dir = path.dirname(toPath);
              //    await fs.mkdir(dir, { recursive: true });
              //    await fs.symlink(fromPath, toPath);
              //  } catch (ex) {
              //    Logger.debug("Failed to symlink", fromPath, toPath, ex);
              //  }
              //}
            });
            await archive.finalize();
          });

          return zipPath;
        },
      );
    }

    function createBucketObject() {
      return new aws.s3.BucketObjectv2(
        `${name}Code`,
        {
          key: interpolate`assets/${name}-code-${bundleHash}.zip`,
          bucket: region.apply((region) =>
            bootstrap.forRegion(region).then((d) => d.asset),
          ),
          source: zipPath.apply((zipPath) => new asset.FileArchive(zipPath)),
        },
        { parent, retainOnDelete: true },
      );
    }

    function createFunction() {
      return new aws.lambda.Function(
        `${name}Function`,
        transform(args.transform?.function, {
          description: args.description,
          code: new asset.AssetArchive({
            index: new asset.StringAsset("exports.handler = () => {}"),
          }),
          handler,
          role: role.arn,
          runtime,
          timeout: timeout.apply((timeout) => toSeconds(timeout)),
          memorySize: memory.apply((memory) => toMBs(memory)),
          environment: {
            variables: environment,
          },
          architectures,
        }),
        { parent },
      );
    }

    function createLogGroup() {
      return new LogGroup(
        `${name}LogGroup`,
        {
          logGroupName: interpolate`/aws/lambda/${fn.name}`,
          retentionInDays: logging.apply(
            (logging) => RETENTION[logging.retention],
          ),
          region,
        },
        { parent },
      );
    }

    function createUrl() {
      return url.apply((url) => {
        if (url === undefined) return;

        return new aws.lambda.FunctionUrl(
          `${name}Url`,
          {
            functionName: fn.name,
            authorizationType: url.authorization.toUpperCase(),
            invokeMode: streaming.apply((streaming) =>
              streaming ? "RESPONSE_STREAM" : "BUFFERED",
            ),
            cors: url.cors,
          },
          { parent },
        );
      });
    }

    function updateFunctionCode() {
      return output([fnRaw]).apply(([fnRaw]) => {
        new FunctionCodeUpdater(
          `${name}CodeUpdater`,
          {
            functionName: fnRaw.name,
            s3Bucket: file.bucket,
            s3Key: file.key,
            functionLastModified: fnRaw.lastModified,
            region,
          },
          { parent },
        );
        return fnRaw;
      });
    }
  }

  public get nodes() {
    return {
      function: this.function,
      role: this.role,
    };
  }

  public get url() {
    return this.fnUrl.apply((url) => url?.functionUrl ?? output(undefined));
  }

  public get arn() {
    return this.function.arn;
  }

  public get logGroupArn() {
    return this.logGroup.logGroupArn;
  }

  /** @internal */
  public getSSTLink(): Link.Definition {
    return {
      type: `{ functionName: string }`,
      value: {
        functionName: this.function.name,
      },
    };
  }

  /** @internal */
  public getSSTAWSPermissions() {
    return [
      {
        actions: ["lambda:InvokeFunction"],
        resources: [this.function.arn],
      },
    ];
  }
}
