import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsNotReservedShareSlug } from './share-slug.validator';

export class CreateShareDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;

  @IsBoolean()
  @IsOptional()
  includeSubPages: boolean;

  @IsOptional()
  @IsBoolean()
  searchIndexing: boolean;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, {
    message:
      'Share slug must start with a letter or number and may contain hyphens and underscores',
  })
  @IsNotReservedShareSlug({
    message: 'Share slug cannot look like a share id or key',
  })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' ? value.trim() : value,
  )
  slug?: string;
}

export class UpdateShareDto extends CreateShareDto {
  @IsString()
  @IsNotEmpty()
  shareId: string;

  @IsString()
  @IsOptional()
  pageId: string;
}

export class ShareIdDto {
  @IsString()
  @IsNotEmpty()
  shareId: string;
}

export class SpaceIdDto {
  @IsUUID()
  spaceId: string;
}

export class ShareInfoDto {
  @IsString()
  @IsOptional()
  shareId?: string;

  @IsString()
  @IsOptional()
  pageId: string;
}

export class SharePageIdDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;
}
