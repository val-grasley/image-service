import { App } from 'aws-cdk-lib';
import { ImageServiceStack } from '../lib/image-service-stack.ts';

new ImageServiceStack(new App(), 'ImageServiceStack');
