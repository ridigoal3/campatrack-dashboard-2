/*
  Limpia dbo.users y deja solo el usuario API `ricardo`.
  Contraseña en claro: gonzales (mismo hash SHA-256 hex que el cliente: usuario + LF + clave).

  Ejecutar manualmente en SQL Server (p. ej. ssms) contra la base configurada en el servidor API.
*/
SET NOCOUNT ON;

DECLARE @ricardoHash NVARCHAR(128) = N'f4bb1dfd3851460840411b77a4b27e306d4ed5d443eb6bd6513ed7c947e8298a';
DECLARE @profileJson NVARCHAR(MAX) = N'{"teams":["team_maestrias","team_edex"]}';

DELETE FROM dbo.users
WHERE LOWER(LTRIM(RTRIM(username))) <> N'ricardo';

IF NOT EXISTS (
  SELECT 1 FROM dbo.users WHERE LOWER(LTRIM(RTRIM(username))) = N'ricardo'
)
BEGIN
  INSERT INTO dbo.users (username, password, role, profile_json)
  VALUES (N'ricardo', @ricardoHash, N'usuario', @profileJson);
END
ELSE
BEGIN
  UPDATE dbo.users
  SET
    password = @ricardoHash,
    role = N'usuario',
    profile_json = @profileJson
  WHERE LOWER(LTRIM(RTRIM(username))) = N'ricardo';
END
