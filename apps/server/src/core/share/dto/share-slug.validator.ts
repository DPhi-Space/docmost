import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { validate as isValidUUID } from 'uuid';

/**
 * The random share `key` is a 10-char lowercase alphanumeric nanoid
 * (see common/helpers/nanoid.utils.ts). A custom slug must never be able to
 * take the shape of a share `id` (UUID) or a `key`, otherwise it could shadow
 * another share in the case-insensitive key/slug lookup branch of ShareRepo.
 */
const NANOID_KEY_SHAPE = /^[0-9a-z]{10}$/;

export function isReservedShareSlug(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return isValidUUID(value) || NANOID_KEY_SHAPE.test(value.toLowerCase());
}

@ValidatorConstraint({ name: 'isNotReservedShareSlug', async: false })
export class IsNotReservedShareSlugConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    // Let @IsOptional / @IsString handle absence and type errors.
    if (value === undefined || value === null) return true;
    if (typeof value !== 'string') return true;
    return !isReservedShareSlug(value);
  }

  defaultMessage(): string {
    return 'Slug cannot look like a share id or key';
  }
}

export function IsNotReservedShareSlug(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsNotReservedShareSlugConstraint,
    });
  };
}
