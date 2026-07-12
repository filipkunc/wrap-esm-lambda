// AWS Lambda handler
// (comments and blank lines below get stripped by codegen,
//  which shifts the throw to a different line in the output)


export const handler = async (event) => {
  const detail = { id: event?.id ?? 42 };


  // the failing line is line 11 in THIS original file
  throw new Error(`boom for ${detail.id}`);
};
