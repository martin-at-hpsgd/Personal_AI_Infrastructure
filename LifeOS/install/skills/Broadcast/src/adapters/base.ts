/**
 * Broadcast - Base Adapter Interface
 */

import type { Platform, PostResult, Credentials, MediaAttachment } from '../types';

export abstract class BaseAdapter {
  abstract readonly name: Platform;
  abstract readonly maxLength: number;

  protected credentials: Credentials;

  constructor(credentials: Credentials) {
    this.credentials = credentials;
  }

  /**
   * Check if this platform is configured with credentials
   */
  abstract isConfigured(): boolean;

  /**
   * Post content to this platform
   */
  abstract post(content: string, media?: MediaAttachment[]): Promise<PostResult>;

  /**
   * Verify that credentials are valid
   */
  abstract verifyCredentials(): Promise<boolean>;

  /**
   * Truncate content to platform limit with ellipsis
   */
  protected truncate(content: string): string {
    if (content.length <= this.maxLength) {
      return content;
    }
    return content.slice(0, this.maxLength - 3) + '...';
  }

  /**
   * Create a success result
   */
  protected success(postId: string, postUrl: string, adaptedContent?: string): PostResult {
    return {
      platform: this.name,
      success: true,
      postId,
      postUrl,
      adaptedContent,
    };
  }

  /**
   * Create a failure result
   */
  protected failure(error: string): PostResult {
    return {
      platform: this.name,
      success: false,
      error,
    };
  }
}
