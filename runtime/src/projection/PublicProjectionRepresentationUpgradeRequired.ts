/** A validated stored representation cannot be returned by an older read
 * contract. This is a consumer migration boundary, not storage corruption. */
export class PublicProjectionRepresentationUpgradeRequired extends Error {
  constructor() {
    super('public_projection_representation_upgrade_required');
    this.name = 'PublicProjectionRepresentationUpgradeRequired';
  }
}
