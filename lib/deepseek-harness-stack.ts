import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { BEDROCK_MODELS, LlmProvider } from './deploy-config';
import { HarnessNetwork, NetworkConfig } from './network';

export interface DeepseekHarnessStackProps extends cdk.StackProps {
  /** `bedrock`: DeepSeek on Amazon Bedrock; `deepseek-api`: DeepSeek's own API. */
  readonly llmProvider: LlmProvider;
  /** Bedrock model id (a key of BEDROCK_MODELS); used when llmProvider is bedrock. */
  readonly bedrockModel: string;
  /**
   * Invoke the model through a tagged application inference profile, so token
   * costs carry the stack's cost allocation tags. Used when llmProvider is bedrock.
   */
  readonly bedrockInferenceProfile: boolean;
  /** EC2 instance type. Graviton (t4g/m7g) and x86 are both supported. */
  readonly instanceType: string;
  /** Version of the @deepseek-ai/dsh npm package to install. */
  readonly dshVersion: string;
  /** Node.js major version to install. */
  readonly nodeMajor: number;
  /** Port the Web UI listens on (always bound to 127.0.0.1 on the instance). */
  readonly webPort: number;
  /** Root EBS volume size in GiB (holds the workspace and ~/.dsh). */
  readonly volumeSizeGiB: number;
  /** A VPC to create, or an existing VPC and subnet to deploy into. */
  readonly network: NetworkConfig;
  /** Use an existing secret that holds DEEPSEEK_API_KEY (deepseek-api only). */
  readonly existingSecretArn?: string;
  /**
   * Block the agent's OS user from reaching the instance metadata service,
   * so commands the agent runs cannot use the instance role's credentials.
   */
  readonly blockImdsForAgent: boolean;
}

export class DeepseekHarnessStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DeepseekHarnessStackProps) {
    super(scope, id, props);

    const network = new HarnessNetwork(this, 'Network', props.network);
    const vpc = network.vpc;

    const useBedrock = props.llmProvider === 'bedrock';
    const model = BEDROCK_MODELS[props.bedrockModel];
    if (useBedrock && !model) {
      throw new Error(`Unsupported bedrockModel "${props.bedrockModel}"`);
    }

    // The API key never lives in the template: the placeholder is replaced
    // after deploy with `scripts/set-api-key.sh` (or put-secret-value).
    let apiKeySecret: secretsmanager.ISecret | undefined;
    if (!useBedrock) {
      apiKeySecret = props.existingSecretArn
        ? secretsmanager.Secret.fromSecretCompleteArn(this, 'ApiKey', props.existingSecretArn)
        : new secretsmanager.Secret(this, 'ApiKey', {
            description: 'DEEPSEEK_API_KEY for DeepSeek Harness',
            secretStringValue: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
          });
    }

    // An application inference profile is a taggable alias of the model: calls
    // made through it are billed under the stack's tags (see doc/budgets.md).
    const foundationModelArn = `arn:${this.partition}:bedrock:${this.region}::foundation-model/${props.bedrockModel}`;
    let inferenceProfile: bedrock.CfnApplicationInferenceProfile | undefined;
    if (useBedrock && props.bedrockInferenceProfile) {
      inferenceProfile = new bedrock.CfnApplicationInferenceProfile(this, 'InferenceProfile', {
        inferenceProfileName: profileText(`${this.stackName}-${props.bedrockModel}`, false).slice(0, 64),
        description: profileText(`${model.name} for DeepSeek Harness stack ${this.stackName}`, true),
        modelSource: { copyFrom: foundationModelArn },
      });
    }
    const bedrockModelId = inferenceProfile?.attrInferenceProfileArn ?? props.bedrockModel;

    // No ingress at all: the Web UI only listens on loopback and is reached
    // through SSM Session Manager port forwarding.
    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'DeepSeek Harness host - egress only',
      allowAllOutbound: true,
    });

    const instanceType = new ec2.InstanceType(props.instanceType);
    const cpuType =
      instanceType.architecture === ec2.InstanceArchitecture.ARM_64
        ? ec2.AmazonLinuxCpuType.ARM_64
        : ec2.AmazonLinuxCpuType.X86_64;

    // Created up front (instead of letting ec2.Instance make one) so the
    // Bedrock role below can trust it before the user data is assembled.
    const instanceRole = new iam.Role(this, 'HostRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    apiKeySecret?.grantRead(instanceRole);

    // The agent never sees the instance role: a root-owned timer on the host
    // assumes this Bedrock-only role and hands its short-lived credentials to
    // the agent's user (see assets/bootstrap.sh).
    let bedrockRole: iam.Role | undefined;
    if (useBedrock) {
      bedrockRole = new iam.Role(this, 'BedrockRole', {
        assumedBy: new iam.ArnPrincipal(instanceRole.roleArn),
        description: 'DeepSeek Harness agent: invoke the DeepSeek model on Bedrock only',
      });
      bedrockRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [foundationModelArn, ...(inferenceProfile ? [inferenceProfile.attrInferenceProfileArn] : [])],
        }),
      );
      bedrockRole.grantAssumeRole(instanceRole);
    }

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      `export LLM_PROVIDER='${props.llmProvider}'`,
      `export SECRET_ARN='${apiKeySecret?.secretArn ?? ''}'`,
      `export BEDROCK_ROLE_ARN='${bedrockRole?.roleArn ?? ''}'`,
      `export BEDROCK_MODEL_ID='${useBedrock ? bedrockModelId : ''}'`,
      `export BEDROCK_MODEL_NAME='${useBedrock ? `${model.name} (Bedrock)` : ''}'`,
      `export BEDROCK_CONTEXT_WINDOW='${model?.contextWindow ?? ''}'`,
      `export BEDROCK_MAX_TOKENS='${model?.maxTokens ?? ''}'`,
      `export DSH_VERSION='${props.dshVersion}'`,
      `export NODE_MAJOR='${props.nodeMajor}'`,
      `export WEB_PORT='${props.webPort}'`,
      `export BLOCK_IMDS='${props.blockImdsForAgent}'`,
      fs.readFileSync(path.join(__dirname, '..', 'assets', 'bootstrap.sh'), 'utf8'),
    );

    const instance = new ec2.Instance(this, 'Host', {
      vpc,
      vpcSubnets: network.subnets,
      associatePublicIpAddress: network.publicIp ? true : undefined,
      instanceType,
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType }),
      securityGroup,
      role: instanceRole,
      userData,
      requireImdsv2: true,
      // Instance tags are not inherited by EBS volumes otherwise, which would
      // leave the disk out of tag-based cost reports and budgets.
      propagateTagsToVolumeOnCreation: true,
      ssmSessionPermissions: true,
      resourceSignalTimeout: cdk.Duration.minutes(20),
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(props.volumeSizeGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });
    // Install aws-cfn-bootstrap first in bootstrap.sh; this trap reports the
    // script's exit code so `cdk deploy` fails if provisioning fails.
    userData.addSignalOnExitCommand(instance);

    // Cost allocation tags (see doc/budgets.md): `app` groups every
    // deployment, `stack` tells apart several deployments in one account.
    cdk.Tags.of(this).add('app', 'deepseek-harness');
    cdk.Tags.of(this).add('stack', this.stackName);

    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'LlmProvider', { value: props.llmProvider });
    if (apiKeySecret) new cdk.CfnOutput(this, 'ApiKeySecretArn', { value: apiKeySecret.secretArn });
    if (bedrockRole) {
      new cdk.CfnOutput(this, 'BedrockModelId', { value: bedrockModelId });
      new cdk.CfnOutput(this, 'BedrockRoleArn', { value: bedrockRole.roleArn });
    }
    new cdk.CfnOutput(this, 'WebPort', { value: String(props.webPort) });
    new cdk.CfnOutput(this, 'PortForwardCommand', {
      value:
        `aws ssm start-session --region ${this.region} --target ${instance.instanceId} ` +
        `--document-name AWS-StartPortForwardingSession ` +
        `--parameters portNumber=${props.webPort},localPortNumber=${props.webPort}`,
    });
  }
}

/**
 * Bedrock inference profile names allow alphanumerics (descriptions also ":"
 * and "."), each optionally followed by a single " ", "_" or "-".
 */
function profileText(text: string, allowPunctuation: boolean): string {
  const disallowed = allowPunctuation ? /[^0-9a-zA-Z:. _-]+/g : /[^0-9a-zA-Z _-]+/g;
  return text.replace(disallowed, '-').replace(/([ _-])[ _-]+/g, '$1').replace(/^[ _-]+/, '');
}
