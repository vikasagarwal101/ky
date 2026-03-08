import {SchemaValidationError} from '../errors/SchemaValidationError.js';
import type {StandardSchemaV1} from '../types/standard-schema.js';

/**
 * Validates a JSON value against a Standard Schema specification.
 *
 * @param jsonValue - The JSON value to validate
 * @param schema - The Standard Schema specification to validate against
 * @returns The validated value from the schema
 * @throws {TypeError} If the schema does not follow the Standard Schema specification
 * @throws {SchemaValidationError} If the validation fails
 */
export const validateJsonWithSchema = async (jsonValue: unknown, schema: StandardSchemaV1): Promise<unknown> => {
	if (
		(
			typeof schema !== 'object'
			&& typeof schema !== 'function'
		)
		|| schema === null
	) {
		throw new TypeError('The `schema` argument must follow the Standard Schema specification');
	}

	const standardSchema = schema['~standard'];

	if (
		typeof standardSchema !== 'object'
		|| standardSchema === null
		|| typeof standardSchema.validate !== 'function'
	) {
		throw new TypeError('The `schema` argument must follow the Standard Schema specification');
	}

	const validationResult = await standardSchema.validate(jsonValue);

	if (validationResult.issues) {
		throw new SchemaValidationError(validationResult.issues);
	}

	return validationResult.value;
};
