import { CreateFeedbackDto } from './support.dto';

describe('CreateFeedbackDto.answers.overallExperience (M-46)', () => {
  it.each([1, 3, 5])('accepts the integer %p', (overallExperience) => {
    const parsed = CreateFeedbackDto.parse({ answers: { overallExperience } });
    expect(parsed.answers.overallExperience).toBe(overallExperience);
  });

  it.each([0, 6, 2.5, '4', null])('rejects %p', (overallExperience) => {
    expect(CreateFeedbackDto.safeParse({ answers: { overallExperience } }).success).toBe(false);
  });

  it('is optional and the catchall still keeps unknown keys', () => {
    const parsed = CreateFeedbackDto.parse({ answers: { tenure: '1-2y', somethingNew: { a: 1 } } });
    expect(parsed.answers.overallExperience).toBeUndefined();
    expect(parsed.answers.somethingNew).toEqual({ a: 1 });
  });
});
