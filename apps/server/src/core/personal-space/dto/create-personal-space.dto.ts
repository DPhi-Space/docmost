import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform, TransformFnParams } from 'class-transformer';

export class CreatePersonalSpaceDto {
  /**
   * Optional: the client pre-fills "<first name>'s space" but the server
   * derives its own default when the field is absent. The slug is never
   * accepted from the client — it is generated (see PersonalSpaceService).
   */
  @IsOptional()
  @MinLength(2)
  @MaxLength(100)
  @IsString()
  @Transform(({ value }: TransformFnParams) => value?.trim())
  name?: string;
}
