import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachedMethods,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  Distribution,
  HttpVersion,
  OriginRequestCookieBehavior,
  OriginRequestHeaderBehavior,
  OriginRequestPolicy,
  OriginRequestQueryStringBehavior,
  ViewerProtocolPolicy,
  type BehaviorOptions,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, FunctionUrlAuthType, InvokeMode, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  type AwsSdkCall,
} from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import apiManifest from '../../apps/api/package.json' with { type: 'json' };

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const UI_PATHS = ['/index.html', '/favicon.ico', '/assets/*'];
// Served by the API but cached at the edge, so they go stale when the API changes.
const API_DOC_PATHS = ['/docs*', '/openapi.json'];

// aws-cdk-lib types Bucket.isWebsite as `boolean | undefined` but IBucket's as an optional
// boolean, which exactOptionalPropertyTypes rejects; its consumers only test it for truthiness.
class UiBucket extends Bucket {
  override get isWebsite(): boolean {
    return super.isWebsite ?? false;
  }
}

export class ImageServiceStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { readonly uiSourcePath?: string } = {},
  ) {
    super(scope, id, props);
    const uiSourcePath = props.uiSourcePath ?? `${repoRoot}apps/web/dist`;

    const table = new Table(this, 'RateLimit', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const api = new NodejsFunction(this, 'Api', {
      entry: `${repoRoot}apps/api/src/lambda.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 1536,
      timeout: Duration.seconds(20),
      reservedConcurrentExecutions: 10,
      environment: {
        RATE_LIMIT_BACKEND: 'dynamodb',
        RATE_LIMIT_TABLE: table.tableName,
        CLIENT_IP_SOURCE: 'cloudfront',
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node24',
        forceDockerBundling: false,
        // esbuild turns a bundled CommonJS require of a Node built-in (undici has many) into a
        // shim that throws in ESM output unless a module-scoped `require` exists.
        banner:
          "import { createRequire as bundleCreateRequire } from 'node:module'; const require = bundleCreateRequire(import.meta.url);",
        define: { SERVICE_VERSION: JSON.stringify(apiManifest.version) },
        externalModules: ['sharp'],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_input, output) => [
            `npm install --prefix "${output}" --os=linux --cpu=arm64 --libc=glibc --no-save --no-package-lock --no-audit --no-fund sharp@${apiManifest.dependencies.sharp}`,
          ],
        },
      },
    });
    table.grantWriteData(api);
    const apiUrl = api.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM,
      invokeMode: InvokeMode.RESPONSE_STREAM,
    });

    const uiBucket = new UiBucket(this, 'Ui', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const uiBehavior: BehaviorOptions = {
      origin: S3BucketOrigin.withOriginAccessControl(uiBucket),
      cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    };
    const distribution = new Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: FunctionUrlOrigin.withOriginAccessControl(apiUrl),
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: false,
        cachePolicy: new CachePolicy(this, 'ApiCachePolicy', {
          queryStringBehavior: CacheQueryStringBehavior.all(),
          headerBehavior: CacheHeaderBehavior.none(),
          cookieBehavior: CacheCookieBehavior.none(),
          defaultTtl: Duration.seconds(0),
          minTtl: Duration.seconds(0),
          maxTtl: Duration.days(1),
          enableAcceptEncodingGzip: false,
          enableAcceptEncodingBrotli: false,
        }),
        originRequestPolicy: new OriginRequestPolicy(this, 'ApiOriginRequestPolicy', {
          headerBehavior: OriginRequestHeaderBehavior.allowList(
            'CloudFront-Viewer-Address',
            'X-Image-Service-Fetch',
            'X-Request-Id',
          ),
          queryStringBehavior: OriginRequestQueryStringBehavior.all(),
          cookieBehavior: OriginRequestCookieBehavior.none(),
        }),
      },
      additionalBehaviors: Object.fromEntries(UI_PATHS.map((path) => [path, uiBehavior])),
      defaultRootObject: 'index.html',
      httpVersion: HttpVersion.HTTP2_AND_3,
    });
    // FunctionUrlOrigin grants CloudFront only lambda:InvokeFunctionUrl; function URLs created
    // since October 2025 also require lambda:InvokeFunction, which this adds scoped to URL calls.
    api.grantInvokeUrl(
      new ServicePrincipal('cloudfront.amazonaws.com').withConditions({
        ArnLike: { 'aws:SourceArn': distribution.distributionArn },
      }),
    );

    new BucketDeployment(this, 'UiDeployment', {
      sources: [Source.asset(uiSourcePath)],
      destinationBucket: uiBucket,
      distribution,
      distributionPaths: UI_PATHS,
    });

    const apiVersion = api.currentVersion.version;
    const invalidateApiDocs: AwsSdkCall = {
      service: 'CloudFront',
      action: 'createInvalidation',
      parameters: {
        DistributionId: distribution.distributionId,
        InvalidationBatch: {
          CallerReference: apiVersion,
          Paths: { Quantity: API_DOC_PATHS.length, Items: API_DOC_PATHS },
        },
      },
      physicalResourceId: PhysicalResourceId.of(apiVersion),
    };
    new AwsCustomResource(this, 'ApiDocsInvalidation', {
      onCreate: invalidateApiDocs,
      onUpdate: invalidateApiDocs,
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [distribution.distributionArn] }),
      installLatestAwsSdk: false,
    });

    new CfnOutput(this, 'DistributionDomain', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'FunctionUrl', { value: apiUrl.url });
  }
}
