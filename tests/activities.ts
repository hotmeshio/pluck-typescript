const sendNewsLetter = async (email:string): Promise<boolean> => {
  console.log('proxied activity; sent ONCE per cycle', email);
  return true;
}

export { sendNewsLetter }
