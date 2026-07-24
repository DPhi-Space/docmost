import { IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';

export class TemplateIdDto {
  @IsUUID()
  templateId: string;
}

export class ListTemplatesDto extends PaginationOptions {
  // Optional space filter. When omitted, the repo returns global templates plus
  // templates in every space the caller can access.
  @IsOptional()
  @IsUUID()
  spaceId?: string;
}

export class CreateTemplateDto {
  @IsString()
  title: string;

  // Omitted / undefined => workspace-global template (admin only).
  @IsOptional()
  @IsUUID()
  spaceId?: string;
}

export class UpdateTemplateDto {
  @IsUUID()
  templateId: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  // Prosemirror JSON document. Kept as an opaque object (matches CreatePageDto).
  @IsOptional()
  content?: any;

  // `null` moves the template to workspace-global scope (admin only); a uuid
  // scopes it to that space. `@IsOptional()` treats null/undefined as "missing"
  // so `@IsUUID()` only runs for a real space id.
  @IsOptional()
  @IsUUID()
  spaceId?: string | null;
}

export class UseTemplateDto {
  @IsUUID()
  templateId: string;

  @IsUUID()
  spaceId: string;

  @IsOptional()
  @IsUUID()
  parentPageId?: string;
}
