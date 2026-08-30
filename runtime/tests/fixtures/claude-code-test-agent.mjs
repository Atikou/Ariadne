let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `claude:${prompt}`
  }));
});
